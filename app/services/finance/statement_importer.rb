require "csv"
require "digest"
require "bigdecimal"

module Finance
  class StatementImporter
    class ImportError < StandardError; end

    MAX_BYTES = 2 * 1024 * 1024
    MAX_ROWS = 5_000
    HEADER_ALIASES = {
      date: ["date", "transaction date", "posting date", "posted date", "booked on", "booking date"],
      description: ["description", "transaction description", "details", "memo", "merchant", "payee", "name"],
      amount: ["amount", "transaction amount", "net amount"],
      debit: ["debit", "debit amount", "withdrawal", "withdrawals", "money out"],
      credit: ["credit", "credit amount", "deposit", "deposits", "money in"],
      category: ["category"],
      currency: ["currency", "currency code"],
      type: ["type", "transaction type", "debit credit", "credit debit"]
    }.freeze
    CATEGORIZATION_RULES = {
      "Transfers" => /\b(transfer|payment thank you|credit card payment|opening balance|balance forward)\b/i,
      "Housing" => /\b(rent|mortgage|property management)\b/i,
      "Food & dining" => /\b(grocery|groceries|supermarket|restaurant|coffee|cafe|dining|whole foods|trader joe|starbucks)\b/i,
      "Transport" => /\b(uber|lyft|transit|metro|parking|fuel|gas station|shell|exxon)\b/i,
      "Utilities" => /\b(electric|electricity|water bill|internet|utility|utilities|comcast|verizon|at&t|phone bill)\b/i,
      "Health" => /\b(pharmacy|medical|doctor|hospital|dental|cvs|walgreens)\b/i,
      "Business" => /\b(office supplies|software|adobe|notion|github|hosting|business insurance)\b/i,
      "Shopping" => /\b(amazon|target|walmart|shopping|clothing|apparel)\b/i
    }.freeze

    def initialize(user:, file:, currency: "USD", source_sha256: nil, source_filename: nil)
      @user = user
      @file = file
      @currency = currency.to_s.strip.upcase
      @source_sha256 = source_sha256
      @source_filename = source_filename
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
      @user.with_lock do
        profile = Profile.find_or_create_by!(user_id: @user.id) { |record| record.currency = @currency }
        if profile.currency != @currency
          raise ImportError, "This account uses #{profile.currency}. Convert the statement before importing another currency."
        end
        if Statement.exists?(user_id: @user.id, sha256: checksum)
          raise ImportError, "This exact statement has already been imported."
        end

        statement = Statement.create!(user: @user, filename: filename, currency: @currency,
          sha256: checksum, status: "imported", transaction_count: rows.length)
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
    rescue CSV::MalformedCSVError
      raise ImportError, "The CSV could not be read. Check quotes, commas, and the header row."
    rescue ActiveRecord::RecordNotUnique
      raise ImportError, "This exact statement has already been imported."
    rescue ActiveRecord::RecordInvalid => error
      raise ImportError, "The statement could not be imported: #{error.record.errors.full_messages.join(', ')}."
    end

    private

    def parse_rows(text)
      csv = CSV.new(text, headers: true, skip_blanks: true)
      first_row = csv.shift
      raise ImportError, "Include a header row and at least one transaction." unless first_row
      normalized_headers = first_row.headers.map { |header| normalize_header(header) }
      if normalized_headers.reject(&:blank?).uniq.length != normalized_headers.reject(&:blank?).length
        raise ImportError, "Column names must be unique. Remove duplicate headers."
      end
      @columns = HEADER_ALIASES.transform_values do |aliases|
        matches = normalized_headers.each_index.select { |index| aliases.include?(normalized_headers[index]) }
        raise ImportError, "Use only one #{aliases.first} column." if matches.length > 1
        matches.first
      end
      unless @columns[:date] && @columns[:description] && (@columns[:amount] || (@columns[:debit] && @columns[:credit]))
        raise ImportError, "CSV needs Date, Description, Amount columns, or Date, Description, Debit, Credit columns."
      end
      if @columns[:amount] && (@columns[:debit] || @columns[:credit])
        raise ImportError, "Use either a signed Amount column or Debit and Credit columns, not both."
      end

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
        end
        row = csv.shift
        line += 1
      end
      raise ImportError, "The statement contains no transactions." if parsed.empty?
      parsed
    end

    def normalize_header(value)
      value.to_s.strip.downcase.gsub(/[_\-\/]+/, " ").gsub(/\s+/, " ")
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
        categorize(description, amount)
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

    def parse_money(raw, line, blank_zero: false)
      value = raw.strip
      return BigDecimal("0") if value.empty? && blank_zero
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

    def categorize(description, amount)
      return "Transfers" if CATEGORIZATION_RULES["Transfers"].match?(description)
      return "Income" if amount.positive?
      CATEGORIZATION_RULES.find { |category, pattern| category != "Transfers" && pattern.match?(description) }&.first || "Uncategorized"
    end
  end
end
