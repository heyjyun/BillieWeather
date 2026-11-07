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
    DATE_TOKEN = '(?:\d{4}-\d{2}-\d{2}|\d{1,2}/\d{1,2}(?:/\d{4})?)'
    NUMBER_TOKEN = '(?:\d{1,3}(?:,\d{3})+|\d+)\.\d{2}'
    MONEY_TOKEN = "(?:\\(\\s*[$£€¥]?#{NUMBER_TOKEN}\\s*\\)|[+-]?\\s*[$£€¥]?\\s*#{NUMBER_TOKEN}|[$£€¥]\\s*[+-]?#{NUMBER_TOKEN})(?:\\s*(?:DR|CR|[+-]))?"
    DATE_PREFIX = /\A(?<date>#{DATE_TOKEN})\s+(?<rest>.+)\z/
    TRAILING_MONEY = /(?<!\S)(?<token>#{MONEY_TOKEN})\s*\z/i
    SUMMARY_DESCRIPTION = /\A(?:(?:beginning|opening|ending|closing|available|current|previous)\s+(?:daily\s+)?balance|balance\s+(?:forward|brought forward)|total\s+(?:credits|debits|deposits|withdrawals|payments))\b/i

    def initialize(user:, file:, currency: "USD", year: nil)
      @user = user
      @file = file
      @currency = currency.to_s.strip.upcase
      @year = if year.present?
        Integer(year.to_s, 10)
      end
      raise ArgumentError if @year && !@year.between?(1900, 2100)
    rescue ArgumentError, TypeError
      raise ImportError, "Enter a valid four-digit statement year, between 1900 and 2100."
    end

    def call
      raise ImportError, "Choose a PDF statement to upload." unless @file.respond_to?(:read)
      raise ImportError, "Choose a supported currency." unless Profile::CURRENCIES.include?(@currency)

      filename = @file.respond_to?(:original_filename) ? @file.original_filename.to_s : "statement.pdf"
      filename = File.basename(filename.tr("\\", "/"))
      unless File.extname(filename).downcase == ".pdf" && filename.length <= 255
        raise ImportError, "Upload a PDF statement with a filename of 255 characters or fewer."
      end
      @file.rewind if @file.respond_to?(:rewind)
      raw = @file.read(MAX_BYTES + 1)
      raise ImportError, "The PDF is empty." if raw.blank?
      raise ImportError, "PDF statements must be 2 MB or smaller." if raw.bytesize > MAX_BYTES
      raise ImportError, "The file is not a readable PDF. Export a fresh PDF or CSV from your bank." unless raw.b.start_with?("%PDF-".b)

      checksum = Digest::SHA256.hexdigest(raw)
      if Statement.exists?(user_id: @user.id, sha256: checksum)
        raise ImportError, "This exact statement has already been imported."
      end

      rows, warnings = read_document(raw)

      @user.with_lock do
        profile = Profile.find_or_create_by!(user_id: @user.id) { |record| record.currency = @currency }
        if profile.currency != @currency
          raise ImportError, "This account uses #{profile.currency}. Convert the statement before importing another currency."
        end
        # Parsed drafts contain personal financial data too. Remove expired
        # drafts whenever this account starts a new PDF review.
        StatementDraft.where(user_id: @user.id).where("expires_at <= ?", Time.current).delete_all
        StatementDraft.create!(user: @user, filename: filename, sha256: checksum, currency: @currency,
          rows: rows, warnings: warnings, expires_at: 30.minutes.from_now)
      end
    rescue ExtractionTimeout
      raise ImportError, "This PDF took too long to read. Try fewer pages or export the transactions as CSV."
    rescue PDF::Reader::EncryptedPDFError
      raise ImportError, "Password-protected or encrypted PDFs are not supported. Export an unlocked copy or CSV from your bank."
    rescue PDF::Reader::MalformedPDFError, PDF::Reader::UnsupportedFeatureError, Zlib::Error, EOFError
      raise ImportError, "This PDF could not be read. Export a fresh text-based PDF or CSV from your bank."
    rescue ActiveRecord::RecordInvalid => error
      raise ImportError, "The PDF review could not be prepared: #{error.record.errors.full_messages.join(', ')}."
    end

    private

    def read_document(raw)
      Timeout.timeout(TIMEOUT_SECONDS, ExtractionTimeout) { parse_document(raw) }
    rescue ImportError, ExtractionTimeout, PDF::Reader::EncryptedPDFError
      raise
    rescue StandardError
      # The PDF library can raise lower-level errors for unsupported fonts,
      # invalid encodings, or malformed object structures. Do not expose file
      # contents or parser internals in the upload response.
      raise ImportError, "This PDF could not be read. Export a fresh text-based PDF or CSV from your bank."
    end

    def parse_document(raw)
      reader = PDF::Reader.new(StringIO.new(raw))
      if reader.objects.encrypted?
        raise ImportError, "Password-protected or encrypted PDFs are not supported. Export an unlocked copy or CSV from your bank."
      end
      unless reader.page_count.between?(1, MAX_PAGES)
        raise ImportError, "PDF statements must contain 1–#{MAX_PAGES} pages. Split a longer statement before uploading."
      end
      texts = []
      total_bytes = 0
      reader.page_count.times do |index|
        text = reader.page(index + 1).text.to_s
        total_bytes += text.bytesize
        if total_bytes > MAX_TEXT_BYTES
          raise ImportError, "This PDF contains too much text. Split it into smaller statements or export CSV."
        end
        texts << text
      end
      if texts.all?(&:blank?)
        raise ImportError, "No selectable text was found. Scanned or image-only PDFs need OCR first, or a CSV export from your bank."
      end
      rows, warnings = extract_rows(texts.join("\n"))
      if rows.empty?
        raise ImportError, "No transaction rows were recognized. Use a text-based statement with dates at the start of each row, or export CSV."
      end
      if texts.any?(&:blank?)
        warnings << "One or more pages had no selectable text and may contain transactions that were not extracted."
      end
      [rows, warnings]
    end

    def extract_rows(text)
      rows = []
      warnings = [
        "PDF layouts vary. Only date-prefixed lines are extracted; wrapped descriptions, continuation lines, and other layouts may be omitted. Compare every row, transaction count, and totals with the original statement before confirming.",
        "Positive means money in; negative means money out. Unsigned amounts and multiple amount columns are left blank instead of guessing. Verify every debit/credit direction."
      ]
      normalized_text = text.encode("UTF-8", invalid: :replace, undef: :replace)
        .tr("\u00A0\u2212", " -").gsub(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/, "")
      normalized_text.each_line do |line|
        match = DATE_PREFIX.match(line.strip)
        next unless match
        date_text = match[:date]
        rest = match[:rest].strip
        next if /\A(?:through|to|[-–—])\s*#{DATE_TOKEN}\z/i.match?(rest)
        if SUMMARY_DESCRIPTION.match?(rest)
          warnings << "A dated balance or summary line was skipped. Check statement totals separately."
          next
        end
        raise ImportError, "PDF review supports at most #{MAX_ROWS} candidate transactions. Split the statement or export CSV." if rows.length >= MAX_ROWS

        number = rows.length + 1
        booked_on = parse_date(date_text, number)
        if (second_date = /\A#{DATE_TOKEN}\s+/.match(rest))
          rest = rest[second_date.end(0)..].strip
          warnings << "Row #{number}: two dates were found; the first was used. Verify the transaction date."
        end
        tokens = []
        while (amount_match = TRAILING_MONEY.match(rest)) && tokens.length < 4
          tokens.unshift(amount_match[:token].strip)
          rest = rest[0...amount_match.begin(:token)].strip
        end

        amount = ""
        if tokens.length == 1
          amount, warning = signed_amount(tokens.first)
          warnings << "Row #{number}: #{warning}" if warning
        elsif tokens.length > 1
          warnings << "Row #{number}: multiple amount columns may include a running balance. Enter only the signed transaction amount."
        else
          warnings << "Row #{number}: no clear trailing amount was found. Enter the signed transaction amount or remove this row."
        end
        if rest.empty?
          rest = "Transaction - verify description"
          warnings << "Row #{number}: description could not be extracted; enter it from the original statement."
        elsif rest.length > 500
          rest = rest[0, 500]
          warnings << "Row #{number}: description was shortened; verify it against the original statement."
        end
        rows << {"booked_on" => booked_on.iso8601, "description" => rest, "amount" => amount}
      end
      if @used_partial_dates
        warnings << "Dates without a year use your supplied year #{@year}. Check every year, especially statements spanning December and January."
      end
      warnings = warnings.uniq
      if warnings.length > 1_000
        warnings = warnings.first(999) + ["Further row-specific warnings were omitted. Verify every date, description, sign, and amount before confirming."]
      end
      [rows, warnings]
    end

    def parse_date(value, number)
      if /\A\d{1,2}\/\d{1,2}\z/.match?(value)
        raise ImportError, "This PDF has MM/DD dates. Enter the statement year and upload again." unless @year
        @used_partial_dates = true
        value = "#{value}/#{@year}"
      end
      date = if value.include?("-")
        Date.strptime(value, "%Y-%m-%d")
      else
        Date.strptime(value, "%m/%d/%Y")
      end
      raise ArgumentError unless date.year.between?(1900, 2100)
      date
    rescue ArgumentError
      raise ImportError, "PDF row #{number} has an invalid date. Use a CSV export or correct the statement before importing."
    end

    def signed_amount(token)
      value = token.delete(" \t\r\n")
      symbol = value[/[$£€¥]/]
      symbol_currencies = {"$" => %w[USD CAD AUD NZD SGD HKD], "£" => ["GBP"], "€" => ["EUR"], "¥" => %w[JPY CNY]}
      if symbol && !symbol_currencies.fetch(symbol).include?(@currency)
        return ["", "the amount's currency symbol does not match #{@currency}. Convert it before entering an amount."]
      end
      negative = value.start_with?("(", "-") || value.end_with?("DR", "dr", "-") || /\A[$£€¥]-/.match?(value)
      positive = value.start_with?("+") || value.end_with?("CR", "cr", "+") || /\A[$£€¥]\+/.match?(value)
      if negative && positive
        return ["", "conflicting debit/credit markers were found. Enter the correct signed amount."]
      end
      unless negative || positive
        return ["", "the amount has no debit/credit sign. Enter a positive income or negative expense amount."]
      end
      number = BigDecimal(value.gsub(/[()$£€¥,+-]|DR|CR/i, ""))
      return ["", "the amount exceeds the supported limit."] if number.abs >= 10**13
      whole, fraction = number.to_s("F").split(".")
      sign = negative ? "-" : "+"
      ["#{sign}#{whole}.#{fraction.to_s.ljust(2, '0')}", nil]
    rescue ArgumentError
      ["", "the amount could not be interpreted. Enter it from the original statement."]
    end
  end
end
