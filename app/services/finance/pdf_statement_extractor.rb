require "pdf/reader"
require "stringio"
require "digest"
require "timeout"
require "bigdecimal"

module Finance
  class PdfStatementExtractor
    ImportError = StatementImporter::ImportError
    class ExtractionTimeout < StandardError; end

    MAX_BYTES = 2 * 1024 * 1024
    MAX_PAGES = 20
    MAX_ROWS = StatementDraft::MAX_ROWS
    MAX_TEXT_BYTES = 512 * 1024
    TIMEOUT_SECONDS = 12
    # Always shown on the review page. They are advice about every PDF, not a sign
    # that something specific went wrong, so they never block automatic import.
    GENERIC_NOTICES = [
      "PDF layouts vary. Only date-prefixed lines are extracted; wrapped descriptions, continuation lines, and other layouts may be omitted. Compare every row, transaction count, and totals with the original statement before confirming.",
      "Positive means money in; negative means money out. Unsigned amounts and multiple amount columns are left blank instead of guessing. Verify every debit/credit direction."
    ].freeze

    def self.localized_warning(warning)
      index = GENERIC_NOTICES.index(warning)
      index ? I18n.t("billie.backend.pdf_generic_#{index + 1}") : warning
    end
    DATE_TOKEN = '(?:\d{4}-\d{2}-\d{2}|\d{1,2}/\d{1,2}(?:/\d{4})?)'
    NUMBER_TOKEN = '(?:\d{1,3}(?:,\d{3})+|\d+)\.\d{2}'
    MONEY_TOKEN = "(?:\\(\\s*[$£€¥]?#{NUMBER_TOKEN}\\s*\\)|[+-]?\\s*[$£€¥]?\\s*#{NUMBER_TOKEN}|[$£€¥]\\s*[+-]?#{NUMBER_TOKEN})(?:\\s*(?:DR|CR|[+-]))?"
    # "Ending balance $1,234.56", "Closing balance: (50.00)", "Ending balance 10/31/2025 1,234.56 CR".
    # Only ending/closing balances count; a credit card's "new balance" is money owed, not cash.
    CLOSING_BALANCE = /\b(?:ending|closing)\s+balance\b[^\d()+-]*?(?<amount>[-+]?\(?\s*[$£€¥]?\s*[-+]?#{NUMBER_TOKEN}\)?)(?:\s*(?<mark>CR|DR)\b)?/i
    DATE_PREFIX = /\A(?<date>#{DATE_TOKEN})\s+(?<rest>.+)\z/
    TRAILING_MONEY = /(?<!\S)(?<token>#{MONEY_TOKEN})\s*\z/i
    SUMMARY_DESCRIPTION = /\A(?:(?:beginning|opening|ending|closing|available|current|previous)\s+(?:daily\s+)?balance|balance\s+(?:forward|brought forward)|total\s+(?:credits|debits|deposits|withdrawals|payments))\b/i

    # `year` is an optional override. Normally the year is detected from the PDF.
    def initialize(user:, file:, currency: "USD", year: nil)
      @user = user
      @file = file
      @currency = currency.to_s.strip.upcase
      @year = if year.present?
        Integer(year.to_s, 10)
      end
      raise ArgumentError if @year && !@year.between?(1900, 2100)
    rescue ArgumentError, TypeError
      raise ImportError, I18n.t("billie.backend.pdf_invalid_year")
    end

    def call
      raise ImportError, I18n.t("billie.backend.choose_pdf") unless @file.respond_to?(:read)
      raise ImportError, I18n.t("billie.backend.unsupported_currency") unless Profile::CURRENCIES.include?(@currency)

      filename = @file.respond_to?(:original_filename) ? @file.original_filename.to_s : "statement.pdf"
      filename = File.basename(filename.tr("\\", "/"))
      unless File.extname(filename).downcase == ".pdf" && filename.length <= 255
        raise ImportError, I18n.t("billie.backend.pdf_filename_limit")
      end
      @file.rewind if @file.respond_to?(:rewind)
      raw = @file.read(MAX_BYTES + 1)
      raise ImportError, I18n.t("billie.backend.pdf_empty") if raw.blank?
      raise ImportError, I18n.t("billie.backend.pdf_size_limit") if raw.bytesize > MAX_BYTES
      raise ImportError, I18n.t("billie.backend.pdf_not_readable") unless raw.b.start_with?("%PDF-".b)

      checksum = Digest::SHA256.hexdigest(raw)
      if Statement.exists?(user_id: @user.id, sha256: checksum)
        raise ImportError, I18n.t("billie.backend.statement_duplicate")
      end

      rows, warnings = read_document(raw)

      @user.with_lock do
        profile = Profile.find_or_create_by!(user_id: @user.id) { |record| record.currency = @currency }
        if profile.currency != @currency
          raise ImportError, I18n.t("billie.backend.currency_mismatch", currency: profile.currency)
        end
        # Parsed drafts contain personal financial data too. Remove expired
        # drafts whenever this account starts a new PDF review.
        StatementDraft.where(user_id: @user.id).where("expires_at <= ?", Time.current).delete_all
        StatementDraft.create!(user: @user, filename: filename, sha256: checksum, currency: @currency,
          rows: rows, warnings: warnings, expires_at: 30.minutes.from_now,
          closing_balance: @closing_balance, closing_balance_on: @closing_balance_on,
          bank_account: BankAccount.resolve(user: @user, identity: @account_identity),
          balance_observed_on: @balance_observed_on)
      end
    rescue ExtractionTimeout
      raise ImportError, I18n.t("billie.backend.pdf_timeout")
    rescue PDF::Reader::EncryptedPDFError
      raise ImportError, I18n.t("billie.backend.pdf_encrypted")
    rescue PDF::Reader::MalformedPDFError, PDF::Reader::UnsupportedFeatureError, Zlib::Error, EOFError
      raise ImportError, I18n.t("billie.backend.pdf_unreadable")
    rescue ActiveRecord::RecordInvalid => error
      raise ImportError, I18n.t("billie.backend.pdf_prepare_failed", errors: error.record.errors.full_messages.join(", "))
    end

    private

    def read_document(raw)
      Timeout.timeout(TIMEOUT_SECONDS, ExtractionTimeout) { parse_document(raw) }
    rescue ImportError, ExtractionTimeout, PDF::Reader::EncryptedPDFError
      raise
    rescue
      # The PDF library can raise lower-level errors for unsupported fonts,
      # invalid encodings, or malformed object structures. Do not expose file
      # contents or parser internals in the upload response.
      raise ImportError, I18n.t("billie.backend.pdf_unreadable")
    end

    def parse_document(raw)
      reader = PDF::Reader.new(StringIO.new(raw))
      if reader.objects.encrypted?
        raise ImportError, I18n.t("billie.backend.pdf_encrypted")
      end
      unless reader.page_count.between?(1, MAX_PAGES)
        raise ImportError, I18n.t("billie.backend.pdf_page_limit", count: MAX_PAGES)
      end
      texts = []
      total_bytes = 0
      reader.page_count.times do |index|
        text = reader.page(index + 1).text.to_s
        total_bytes += text.bytesize
        if total_bytes > MAX_TEXT_BYTES
          raise ImportError, I18n.t("billie.backend.pdf_text_limit")
        end
        texts << text
      end
      if texts.all?(&:blank?)
        raise ImportError, I18n.t("billie.backend.pdf_no_text")
      end
      rows, warnings = extract_rows(texts.join("\n"))
      if rows.empty?
        raise ImportError, I18n.t("billie.backend.pdf_no_rows")
      end
      if texts.any?(&:blank?)
        warnings << I18n.t("billie.backend.pdf_blank_pages")
      end
      [rows, warnings]
    end

    def extract_rows(text)
      rows = []
      warnings = [
        *GENERIC_NOTICES
      ]
      normalized_text = text.encode("UTF-8", invalid: :replace, undef: :replace)
        .tr("\u00A0\u2212", " -").gsub(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/, "")
      @resolver = StatementYearResolver.new(normalized_text)
      @account_identity = StatementAccountIdentity.from_pdf(text: normalized_text)
      @closing_balance = detect_closing_balance(normalized_text)
      @closing_balance_on = (@closing_balance && @resolver.confident?) ? @resolver.end_date : nil
      normalized_text.each_line do |line|
        match = DATE_PREFIX.match(line.strip)
        next unless match
        date_text = match[:date]
        rest = match[:rest].strip
        next if /\A(?:through|to|[-–—])\s*#{DATE_TOKEN}\z/io.match?(rest)
        if SUMMARY_DESCRIPTION.match?(rest)
          warnings << I18n.t("billie.backend.pdf_skipped_balance")
          next
        end
        raise ImportError, I18n.t("billie.backend.pdf_candidate_limit", count: MAX_ROWS) if rows.length >= MAX_ROWS

        number = rows.length + 1
        booked_on = parse_date(date_text, number)
        if (second_date = /\A#{DATE_TOKEN}\s+/o.match(rest))
          rest = rest[second_date.end(0)..].strip
          warnings << I18n.t("billie.backend.pdf_row_two_dates", row: number)
        end
        tokens = []
        while (amount_match = TRAILING_MONEY.match(rest)) && tokens.length < 4
          tokens.unshift(amount_match[:token].strip)
          rest = rest[0...amount_match.begin(:token)].strip
        end

        amount = ""
        if tokens.length == 1
          amount, warning = signed_amount(tokens.first)
          warnings << I18n.t("billie.backend.pdf_row_warning", row: number, warning: warning) if warning
        elsif tokens.length > 1
          warnings << I18n.t("billie.backend.pdf_row_multiple_amounts", row: number)
        else
          warnings << I18n.t("billie.backend.pdf_row_no_amount", row: number)
        end
        if rest.empty?
          rest = "Transaction - verify description"
          warnings << I18n.t("billie.backend.pdf_row_no_description", row: number)
        elsif rest.length > 500
          rest = rest[0, 500]
          warnings << I18n.t("billie.backend.pdf_row_shortened_description", row: number)
        end
        rows << {"booked_on" => booked_on.iso8601, "description" => rest, "amount" => amount}
      end
      if @used_partial_dates
        if @year
          warnings << I18n.t("billie.backend.pdf_assumed_year", year: @year)
        elsif !@resolver.confident?
          warnings << I18n.t("billie.backend.pdf_uncertain_year", date: @resolver.end_date.iso8601)
        end
      end
      warnings = warnings.uniq
      @balance_observed_on = @resolver.confident? ? @resolver.end_date : rows.map { |row| Date.iso8601(row["booked_on"]) }.max
      if warnings.length > 1_000
        warnings = warnings.first(999) + [I18n.t("billie.backend.pdf_warning_limit")]
      end
      [rows, warnings]
    end

    # The statement's closing balance, or nil when none is found or the PDF disagrees with itself
    # (for example several accounts in one file).
    def detect_closing_balance(text)
      found = text.each_line.filter_map do |line|
        match = CLOSING_BALANCE.match(line.gsub(/#{DATE_TOKEN}/o, " "))
        next unless match
        token = match[:amount]
        negative = token.include?("(") || token.include?("-") || match[:mark].to_s.casecmp?("DR")
        number = BigDecimal(token.gsub(/[^\d.]/, ""))
        negative ? -number : number
      end
      (found.uniq.length == 1 && found.first.abs < 10**13) ? found.first : nil
    end

    def parse_date(value, number)
      if /\A\d{1,2}\/\d{1,2}\z/.match?(value)
        @used_partial_dates = true
        month, day = value.split("/").map(&:to_i)
        year = @year || @resolver.year_for(month, day)
        raise ArgumentError unless year
        value = "#{value}/#{year}"
      end
      date = if value.include?("-")
        Date.strptime(value, "%Y-%m-%d")
      else
        Date.strptime(value, "%m/%d/%Y")
      end
      raise ArgumentError unless date.year.between?(1900, 2100)
      date
    rescue ArgumentError
      raise ImportError, I18n.t("billie.backend.pdf_invalid_row_date", row: number)
    end

    def signed_amount(token)
      value = token.delete(" \t\r\n")
      symbol = value[/[$£€¥]/]
      symbol_currencies = {"$" => %w[USD CAD AUD NZD SGD HKD], "£" => ["GBP"], "€" => ["EUR"], "¥" => %w[JPY CNY]}
      if symbol && !symbol_currencies.fetch(symbol).include?(@currency)
        return ["", I18n.t("billie.backend.pdf_amount_currency", currency: @currency)]
      end
      negative = value.start_with?("(", "-") || value.end_with?("DR", "dr", "-") || /\A[$£€¥]-/.match?(value)
      positive = value.start_with?("+") || value.end_with?("CR", "cr", "+") || /\A[$£€¥]\+/.match?(value)
      if negative && positive
        return ["", I18n.t("billie.backend.pdf_amount_markers")]
      end
      unless negative || positive
        return ["", I18n.t("billie.backend.pdf_amount_unsigned")]
      end
      number = BigDecimal(value.gsub(/[()$£€¥,+-]|DR|CR/i, ""))
      return ["", I18n.t("billie.backend.pdf_amount_limit")] if number.abs >= 10**13
      whole, fraction = number.to_s("F").split(".")
      sign = negative ? "-" : "+"
      ["#{sign}#{whole}.#{fraction.to_s.ljust(2, "0")}", nil]
    rescue ArgumentError
      ["", I18n.t("billie.backend.pdf_amount_unreadable")]
    end
  end
end
