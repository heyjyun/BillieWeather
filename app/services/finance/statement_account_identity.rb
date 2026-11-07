require "digest"

module Finance
  # Account metadata is evidence for grouping statements, never a guess based on
  # a filename or transaction description. Only the last four digits are kept.
  class StatementAccountIdentity
    CSV_HEADERS = {
      bank: ["bank", "bank name", "institution", "institution name", "financial institution"],
      number: ["account", "account number", "account no", "account #", "account id", "card number", "card no", "card #"],
      # Explicit "last four digits" columns. When one exists it is the account number evidence; an
      # internal id column such as "account_id" (e.g. K00025300003) is not an account number.
      mask: ["account mask", "mask", "card mask", "account last4", "account last 4", "account last four", "card last4", "card last 4", "last4", "last 4", "last four"],
      kind: ["account type", "account kind"],
      name: ["account name", "account title"]
    }.freeze

    BANK_ALIASES = {
      "Chase" => /\b(?:j\s*p\s*morgan\s+chase|jpmorgan\s+chase|chase)(?:\s+bank)?\b/i,
      "Bank of America" => /\b(?:bank\s+of\s+america|bofa)\b/i,
      "Wells Fargo" => /\bwells\s+fargo\b/i,
      "Capital One" => /\bcapital\s+one\b/i,
      "Citibank" => /\b(?:citibank|citi\s+bank)\b/i,
      "U.S. Bank" => /\bu\.?\s*s\.?\s+bank\b/i,
      "PNC" => /\bpnc(?:\s+bank)?\b/i,
      "TD Bank" => /\btd\s+bank\b/i,
      "Ally Bank" => /\bally\s+bank\b/i,
      "Discover Bank" => /\bdiscover\s+bank\b/i,
      "American Express" => /\bamerican\s+express\b/i
    }.freeze
    CREDIT_KIND = /\b(?:credit\s+card|card\s+account|visa|mastercard|amex|loan|mortgage|line\s+of\s+credit)\b/i
    CASH_KIND = /\b(?:checking|savings?|chequing|deposit|money\s+market|cash)\b/i
    ACCOUNT_TOKEN = '(?:[xX*\u2022#\d][xX*\u2022#\d \t-]*\d)'
    ACCOUNT_LABEL = /\b(?:account\s*(?:number|no\.?|#)|(?:checking|savings?|chequing)\s+account(?:\s*(?:number|no\.?|#))?|card\s*(?:number|no\.?|#)|(?:account|card)\s+ending\s+(?:in\s+)?)\s*[:#-]?\s*(?<number>#{ACCOUNT_TOKEN})/i
    TRANSACTION_LINE = /\A\s*(?:\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2}(?:\/\d{4})?)\s+/

    def self.from_csv(headers:, rows:)
      normalized = headers.map { |header| normalize(header) }
      columns = CSV_HEADERS.transform_values do |aliases|
        normalized.each_index.select { |index| aliases.include?(normalized[index]) }
      end
      values = columns.transform_values do |indices|
        rows.flat_map do |row|
          fields = if row.respond_to?(:fields)
            row.fields
          elsif row.is_a?(Hash)
            headers.map { |header| row[header] || row[header.to_s] }
          else
            row
          end
          indices.map { |index| fields[index].to_s.strip }.reject(&:empty?)
        end.uniq
      end
      banks = values[:bank].map { |value| canonical_bank(value) }.compact.uniq
      # An account title may contain a recognizable bank, but descriptions are
      # deliberately never considered: transfers often name another bank.
      if banks.empty?
        banks = values[:name].flat_map { |value| recognized_banks(value) }.uniq
      end
      number_values = values[:mask].presence || values[:number]
      numbers = number_values.filter_map { |value| last_four(value) }.uniq
      invalid_number = number_values.any? { |value| last_four(value).nil? }
      conflicting_numbers = conflicting_full_numbers?(number_values)
      kinds = values[:kind].map { |value| kind(value) }.uniq
      kinds = values[:name].map { |value| kind(value) }.uniq if kinds.empty?
      kinds.reject! { |value| value == "unknown" }
      build(bank: banks.one? ? banks.first : nil, last4: numbers.one? && !invalid_number ? numbers.first : nil,
        kind: kinds.one? ? kinds.first : "unknown", names: values[:kind] + values[:name],
        ambiguous: banks.length > 1 || numbers.length > 1 || kinds.length > 1 || invalid_number || conflicting_numbers)
    end

    def self.from_pdf(text:)
      # Date-prefixed activity is not account metadata. Bound header inspection
      # so bank names in transaction payees cannot supply the institution.
      document_lines = text.to_s.lines
      lines = document_lines.first(100).reject { |line| TRANSACTION_LINE.match?(line) }
      header = lines.join[0, 12_000]
      banks = recognized_banks(header)
      explicit_banks = lines.filter_map do |line|
        value = line[/\A\s*(?:bank(?:\s+name)?|financial\s+institution|institution)\s*:\s*(.{1,100})\s*\z/i, 1]
        canonical_bank(value) if value
      end
      banks = (banks + explicit_banks).uniq
      # Combined statements can introduce another account on a later page.
      # Inspect account labels throughout the document before accepting one
      # identity, even though institution recognition stays header-bounded.
      account_text = document_lines.reject { |line| TRANSACTION_LINE.match?(line) }.join
      raw_numbers = account_text.scan(ACCOUNT_LABEL).flatten
      numbers = raw_numbers.filter_map { |value| last_four(value) }.uniq
      build(bank: banks.one? ? banks.first : nil, last4: numbers.one? ? numbers.first : nil,
        kind: kind(header), names: [header],
        ambiguous: banks.length > 1 || numbers.length > 1 || conflicting_full_numbers?(raw_numbers))
    end

    # Used when a person identifies an existing statement's bank/account. It
    # shares the detector's normalization so later uploads can match it.
    def self.from_details(bank_name:, account_last4:, account_kind:, account_name: nil)
      account_kind = account_kind.to_s
      account_kind = "unknown" unless %w[cash credit].include?(account_kind)
      build(bank: canonical_bank(bank_name), last4: last_four(account_last4),
        kind: account_kind, names: [account_name.to_s])
    end

    def self.build(bank:, last4:, kind:, names:, ambiguous: false)
      kind = "unknown" if ambiguous
      label = if kind == "credit"
        "Credit account"
      elsif kind == "cash"
        joined = names.join(" ")
        if /\bsavings?\b/i.match?(joined) && !/\b(?:checking|chequing)\b/i.match?(joined)
          "Savings"
        elsif /\b(?:checking|chequing)\b/i.match?(joined) && !/\bsavings?\b/i.match?(joined)
          "Checking"
        else
          "Cash account"
        end
      else
        "Account"
      end
      # Last-four collisions can be corrected by assigning a separate account in
      # review. Masked and unmasked statements must identify the same account.
      key = if bank && last4 && kind != "unknown" && !ambiguous
        Digest::SHA256.hexdigest([normalize(bank), last4, kind].join("|"))
      end
      {bank_name: bank, account_name: "#{label}#{" ••••#{last4}" if last4}",
       account_last4: last4, account_kind: kind, account_key: key}
    end
    private_class_method :build

    def self.kind(value)
      # Exports often use snake_case values such as "credit_card".
      text = value.to_s.tr("_", " ")
      credit = CREDIT_KIND.match?(text) || text.strip.casecmp?("credit")
      cash = CASH_KIND.match?(text)
      return "unknown" if credit == cash
      credit ? "credit" : "cash"
    end
    private_class_method :kind

    def self.last_four(value)
      compact = value.to_s.strip.gsub(/[ \t-]/, "")
      return unless /\A[xX*\u2022#\d]*\d{4}\z/.match?(compact)
      digits = compact.gsub(/\D/, "")
      return unless digits.length.between?(4, 24)
      digits[-4, 4]
    end
    private_class_method :last_four

    def self.conflicting_full_numbers?(values)
      # Keep full numbers in local memory only long enough to notice a collision
      # before reducing them to suffixes. A masked/four-digit representation can
      # still accompany its full number without creating another account.
      values.filter_map do |value|
        compact = value.to_s.strip.gsub(/[ \t-]/, "")
        compact if /\A\d{5,24}\z/.match?(compact)
      end.uniq.length > 1
    end
    private_class_method :conflicting_full_numbers?

    def self.recognized_banks(value)
      BANK_ALIASES.filter_map { |name, pattern| name if pattern.match?(value.to_s) }
    end
    private_class_method :recognized_banks

    def self.canonical_bank(value)
      text = value.to_s.strip.gsub(/\s+/, " ")
      return if text.empty? || text.length > 100 || text.match?(/[\r\n\x00-\x1f]/)
      known = recognized_banks(text)
      return if known.length > 1
      known.first || text.split.map(&:capitalize).join(" ")
    end
    private_class_method :canonical_bank

    def self.normalize(value)
      value.to_s.strip.downcase.gsub(/[_\-\/]+/, " ").gsub(/\s+/, " ")
    end
    private_class_method :normalize
  end
end
