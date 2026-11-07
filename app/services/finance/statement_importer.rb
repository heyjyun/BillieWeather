require "csv"
require "digest"
require "bigdecimal"

module Finance
  class StatementImporter
    class ImportError < StandardError; end

    class DateColumnRequired < ImportError
      attr_reader :date_columns

      def initialize(date_columns)
        @date_columns = date_columns
        super("That date column is not available in this CSV. Use automatic date detection or choose a listed column, then select the file again.")
      end
    end

    attr_reader :date_column_used

    # True when this call only filled in missing account/balance details on a statement that
    # was already imported, instead of importing anything new.
    def refreshed?
      !!@refreshed
    end

    MAX_BYTES = 2 * 1024 * 1024
    MAX_ROWS = 5_000
    DATE_COLUMN_PRIORITY = ["transaction date", "date", "post date", "posting date", "posted date", "booked on", "booking date"].freeze
    # Optional. Read only to find the closing balance; never required, and a column that
    # cannot be read is ignored rather than failing the import.
    # "closing balance" is the name used throughout the app; banks also print "ending balance", so it is accepted too.
    BALANCE_HEADERS = ["closing balance", "ending balance", "running balance", "balance after", "balance after transaction", "post transaction balance",
      "ledger balance", "current balance", "account balance", "available balance", "balance"].freeze
    HEADER_ALIASES = {
      date: DATE_COLUMN_PRIORITY,
      description: ["description", "transaction description", "details", "memo", "merchant", "payee", "name"],
      amount: ["amount", "transaction amount", "net amount"],
      debit: ["debit", "debit amount", "withdrawal", "withdrawals", "money out"],
      credit: ["credit", "credit amount", "deposit", "deposits", "money in"],
      category: ["category"],
      currency: ["currency", "currency code"],
      type: ["type", "transaction type", "debit credit", "credit debit"]
    }.freeze

    def initialize(user:, file:, currency: "USD", source_sha256: nil, source_filename: nil, date_column: nil, closing_balance: nil, closing_balance_on: nil, bank_account: nil, balance_observed_on: nil)
      @user = user
      @file = file
      @currency = currency.to_s.strip.upcase
      @source_sha256 = source_sha256
      @source_filename = source_filename
      @requested_date_column = normalize_header(date_column).presence
      @categorizer = Categorizer.new(user: user)
      @given_closing = closing_balance.nil? ? nil : [closing_balance, closing_balance_on]
      @given_bank_account = bank_account
      @given_observed_on = balance_observed_on
    end

    def call
      raise ImportError, "Choose a CSV statement to upload." unless @file.respond_to?(:read)
      unless Profile::CURRENCIES.include?(@currency)
        raise ImportError, "Choose a supported currency."
      end

      filename = @file.respond_to?(:original_filename) ? @file.original_filename.to_s : "statement.csv"
      filename = File.basename(filename.tr("\\", "/"))
      unless File.extname(filename).downcase == ".csv"
        raise ImportError, "Upload a CSV file. PDF and spreadsheet files must first be exported to CSV."
      end
      raise ImportError, "The filename is too long." if filename.length > 255

      @file.rewind if @file.respond_to?(:rewind)
      raw = @file.read(MAX_BYTES + 1)
      raise ImportError, "The statement is empty." if raw.blank?
      raise ImportError, "Statements must be 2 MB or smaller." if raw.bytesize > MAX_BYTES

      checksum = Digest::SHA256.hexdigest(raw)
      if @source_sha256 || @source_filename
        unless @source_sha256.is_a?(String) && /\A[0-9a-f]{64}\z/.match?(@source_sha256) && @source_filename.is_a?(String)
          raise ImportError, "The original statement details could not be verified. Upload the statement again."
        end
        source_filename = File.basename(@source_filename.tr("\\", "/"))
        unless File.extname(source_filename).downcase == ".pdf" && source_filename.length.between?(1, 255)
          raise ImportError, "The original PDF filename could not be verified. Upload the statement again."
        end
        checksum = @source_sha256
        filename = source_filename
      end
      text = raw.dup.force_encoding(Encoding::UTF_8)
      unless text.valid_encoding?
        raise ImportError, "Save the CSV with UTF-8 encoding and try again."
      end
      raise ImportError, "The file contains binary data. Export the statement as a UTF-8 CSV." if text.include?("\0")
      text = text.delete_prefix("\uFEFF")
      rows = parse_rows(text)

      # Serialize imports and currency changes for this account, while keeping
      # file parsing outside the database transaction.
      statement = @user.with_lock do
        profile = Profile.find_or_create_by!(user_id: @user.id) { |record| record.currency = @currency }
        if profile.currency != @currency
          raise ImportError, "This account uses #{profile.currency}. Convert the statement before importing another currency."
        end
        if (existing = Statement.find_by(user_id: @user.id, sha256: checksum))
          # Uploading the same file again fills in what an earlier import could not read
          # (for example before account or balance columns were recognized). Nothing is
          # imported twice, and details that are already saved are never replaced.
          next refresh_missing_details(existing)
        end

        closing_balance, closing_balance_on = @given_closing || detected_closing_balance
        bank_account = @given_bank_account || BankAccount.resolve(user: @user, identity: @account_identity)
        observed_on = @given_observed_on || rows.map { |row| row[:booked_on] }.max
        statement = Statement.create!(user: @user, filename: filename, currency: @currency,
          sha256: checksum, status: "imported", transaction_count: rows.length,
          closing_balance: closing_balance, closing_balance_on: closing_balance_on,
          bank_account: bank_account, balance_observed_on: observed_on)
        # Every imported field is validated while parsing above. Bulk inserts
        # avoid thousands of round trips to the external Neon database, while
        # the enclosing transaction keeps every batch atomic.
        now = Time.current
        rows.each_slice(500) do |batch|
          Transaction.insert_all!(batch.map do |attributes|
            attributes.merge(user_id: @user.id, statement_id: statement.id, created_at: now, updated_at: now)
          end)
        end
        statement
      end
      # Clean up older Uncategorized rows with the latest rules and remembered merchants.
      Categorizer.recategorize_uncategorized!(user: @user)
      BalanceSync.call(user: @user)
      statement
    rescue CSV::MalformedCSVError
      raise ImportError, "The CSV could not be read. Check quotes, commas, and the header row."
    rescue ActiveRecord::RecordNotUnique
      raise ImportError, "This exact statement has already been imported."
    rescue ActiveRecord::RecordInvalid => error
      raise ImportError, "The statement could not be imported: #{error.record.errors.full_messages.join(", ")}."
    end

    private

    def refresh_missing_details(existing)
      updates = {}
      if existing.bank_account_id.nil?
        account = @given_bank_account || BankAccount.resolve(user: @user, identity: @account_identity)
        updates[:bank_account] = account if account
      end
      if existing.closing_balance.nil?
        balance, balance_on = @given_closing || detected_closing_balance
        if balance
          updates[:closing_balance] = balance
          updates[:closing_balance_on] = balance_on
        end
      end
      raise ImportError, "This exact statement has already been imported." if updates.empty?

      existing.update!(updates)
      @refreshed = true
      existing
    end

    def parse_rows(text)
      csv = CSV.new(text, headers: true, skip_blanks: true)
      first_row = csv.shift
      raise ImportError, "Include a header row and at least one transaction." unless first_row
      normalized_headers = first_row.headers.map { |header| normalize_header(header) }
      if normalized_headers.compact_blank.uniq.length != normalized_headers.compact_blank.length
        raise ImportError, "Column names must be unique. Remove duplicate headers."
      end
      @columns = HEADER_ALIASES.except(:date).transform_values do |aliases|
        matches = normalized_headers.each_index.select { |index| aliases.include?(normalized_headers[index]) }
        raise ImportError, "Use only one #{aliases.first} column." if matches.length > 1
        matches.first
      end
      @columns[:date] = resolve_date_column(first_row.headers, normalized_headers)
      @date_column_used = first_row.headers[@columns[:date]] if @columns[:date]
      has_amount = @columns[:amount] || (@columns[:debit] && @columns[:credit])
      unless @columns[:date] && @columns[:description] && has_amount
        raise ImportError, "CSV needs Date, Description, Amount columns, or Date, Description, Debit, Credit columns."
      end
      if @columns[:amount] && (@columns[:debit] || @columns[:credit])
        raise ImportError, "Use either a signed Amount column or Debit and Credit columns, not both."
      end

      balance_header = BALANCE_HEADERS.find { |name| normalized_headers.include?(name) }
      @columns[:balance] = balance_header && normalized_headers.index(balance_header)
      @balance_points = []
      identity_rows = []
      parsed = []
      row = first_row
      line = 2
      while row
        unless row.fields.all? { |field| field.to_s.strip.empty? }
          raise ImportError, "Statements can contain at most #{MAX_ROWS} transactions." if parsed.length >= MAX_ROWS
          if row.fields.length > first_row.headers.length
            raise ImportError, "Row #{line}: more values than headers. Quote amounts containing commas."
          end
          parsed << parse_row(row.fields, line)
          note_balance(parsed.last[:booked_on], value(row.fields, :balance), parsed.length - 1)
          identity_rows << row.fields
        end
        row = csv.shift
        line += 1
      end
      raise ImportError, "The statement contains no transactions." if parsed.empty?
      @account_identity = StatementAccountIdentity.from_csv(headers: first_row.headers, rows: identity_rows)
      parsed
    end

    def normalize_header(value)
      value.to_s.strip.downcase.gsub(/[_\-\/]+/, " ").gsub(/\s+/, " ")
    end

    def resolve_date_column(headers, normalized_headers)
      matches = normalized_headers.each_index.select { |index| HEADER_ALIASES[:date].include?(normalized_headers[index]) }
      choices = matches.map { |index| headers[index].to_s }
      if @requested_date_column && matches.empty?
        raise ImportError, "The selected date column was not found. Use a Date, Transaction Date, or Posting Date header."
      end
      if @requested_date_column
        selected = matches.find { |index| normalized_headers[index] == @requested_date_column }
        raise DateColumnRequired, choices unless selected
        selected
      else
        # Prefer the transaction's occurrence date consistently across the file.
        # Header order does not affect the selected date column.
        preferred = DATE_COLUMN_PRIORITY.find { |name| normalized_headers.include?(name) }
        normalized_headers.index(preferred) if preferred
      end
    end

    def parse_row(fields, line)
      description = value(fields, :description).strip
      raise ImportError, "Row #{line}: description is required." if description.empty?
      raise ImportError, "Row #{line}: description must be 500 characters or fewer." if description.length > 500
      if @columns[:currency] && value(fields, :currency).strip.upcase != @currency
        raise ImportError, "Row #{line}: currency must be #{@currency}. Mixed currencies are not combined."
      end

      amount = if @columns[:amount]
        parsed = parse_money(value(fields, :amount), line)
        if @columns[:type]
          type = value(fields, :type).strip.downcase
          case type
          when "debit", "withdrawal", "expense", "dr" then -parsed.abs
          when "credit", "deposit", "income", "cr" then parsed.abs
          when "" then parsed
          else raise ImportError, "Row #{line}: Type must be debit or credit."
          end
        else
          parsed
        end
      else
        debit = parse_money(value(fields, :debit), line, blank_zero: true)
        credit = parse_money(value(fields, :credit), line, blank_zero: true)
        if debit.negative? || credit.negative? || (!debit.zero? && !credit.zero?)
          raise ImportError, "Row #{line}: enter a positive value in either Debit or Credit, not both."
        end
        credit - debit
      end

      category = if @columns[:category] && value(fields, :category).present?
        Transaction::CATEGORIES.find { |candidate| candidate.casecmp?(value(fields, :category).strip) } || "Uncategorized"
      else
        @categorizer.categorize(description, amount)
      end
      {booked_on: parse_date(value(fields, :date), line), description: description,
       amount: amount, category: category, tax_review: category == "Business", excluded: false}
    end

    def value(fields, name)
      index = @columns[name]
      index ? fields[index].to_s : ""
    end

    def parse_date(raw, line)
      value = raw.strip
      format = if /\A\d{4}-\d{2}-\d{2}\z/.match?(value)
        "%Y-%m-%d"
      elsif /\A\d{1,2}\/\d{1,2}\/\d{4}\z/.match?(value)
        "%m/%d/%Y"
      end
      raise ArgumentError unless format
      date = Date.strptime(value, format)
      raise ArgumentError unless date.year.between?(1900, 2100)
      date
    rescue ArgumentError
      raise ImportError, "Row #{line}: use a valid date in YYYY-MM-DD or MM/DD/YYYY format (month first)."
    end

    def note_balance(date, raw, index)
      balance = lenient_balance(raw)
      @balance_points << [date, balance, index]
    end

    # A running-balance cell like "1,234.56", "$1,234.56" or "(50.00)"; nil if it is not clearly a number.
    def lenient_balance(raw)
      value = raw.to_s.strip
      return nil if value.empty?
      negative = value.start_with?("(") && value.end_with?(")")
      value = value.delete("()").sub(/\A([+-]?)[$£€¥]/) { Regexp.last_match(1) }.delete(",")
      return nil unless /\A[+-]?\d+(?:\.\d{1,2})?\z/.match?(value)
      number = BigDecimal(value)
      number = -number.abs if negative
      (number.abs < 10**13) ? number : nil
    end

    # The balance on the latest-dated row. When several rows share that date, the file's own
    # order decides: the last of them for oldest-first files, the first for newest-first files.
    def detected_closing_balance
      return [nil, nil] if @balance_points.blank?
      newest_first = @balance_points.first[0] > @balance_points.last[0]
      point = @balance_points.max_by { |date, _balance, index| [date, newest_first ? -index : index] }
      point[1] ? [point[1], point[0]] : [nil, nil]
    end

    def parse_money(raw, line, blank_zero: false)
      value = raw.strip
      return BigDecimal(0) if value.empty? && blank_zero
      if /\A\([^()]+\)\z/.match?(value)
        value = "-#{value[1...-1]}"
      end
      symbol = value[/[$£€¥]/]
      symbol_currencies = {"$" => %w[USD CAD AUD NZD SGD HKD], "£" => ["GBP"], "€" => ["EUR"], "¥" => %w[JPY CNY]}
      if symbol && !symbol_currencies.fetch(symbol).include?(@currency)
        raise ImportError, "Row #{line}: currency symbol does not match #{@currency}."
      end
      value = value.sub(/\A([+-]?)[$£€¥]/) { Regexp.last_match(1) }
      unless /\A[+-]?(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d{1,2})?\z/.match?(value)
        raise ImportError, "Row #{line}: amounts must be numbers with at most two decimals; use a dot decimal separator."
      end
      amount = BigDecimal(value.delete(","))
      if amount.abs >= 10**13
        raise ImportError, "Row #{line}: amount exceeds the supported limit."
      end
      amount
    end
  end
end
