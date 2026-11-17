module Finance
  # Row-level duplicate detection across files (P0-3). Port of packages/finance-core/src/ledger/dedupe.ts
  # (detectDuplicates); both replay packages/finance-core/fixtures/dedupe-cases.json.
  #
  # Account-scoped. For each incoming row in file order:
  #   - duplicate: same account + bank reference, or an exact date + amount + normalized description
  #     match with occurrence counting (an overlapping statement's rows are recognized; two genuine
  #     identical purchases are both kept);
  #   - review: a match only against a row whose account is unknown, or the same merchant written
  #     differently on the same day and amount (a person decides);
  #   - new.
  # Rows are hashes: {id:, account:, date:, amount:, description:, reference:}. Amounts compare exactly.
  class DuplicateDetector
    Verdict = Data.define(:result, :of, :reason)

    def self.description_key(text)
      text.to_s.unicode_normalize(:nfkc).downcase.gsub(/\s+/, " ").strip
    end

    def self.call(existing, incoming)
      new(existing).classify(incoming)
    end

    # Existing stored rows of a user, in the shape the detector reads.
    def self.stored_rows(user, dates: nil, account_id: nil)
      # Receipt entries are matched by Finance::ReceiptReconciler (merchant identity, posting delay), not here.
      scope = Transaction.live.where(user_id: user.id).where.not(entry_origin: "receipt")
      scope = scope.where(booked_on: dates) if dates
      # An unknown account must remain a review candidate; a different known account cannot match.
      scope = scope.where(bank_account_id: [account_id, nil]) if account_id
      scope.pluck(:id, :bank_account_id, :booked_on, :amount, :original_description).map do |id, account, date, amount, description|
        {id: id, account: account, date: date, amount: amount, description: description, reference: nil}
      end
    end

    def initialize(existing)
      @by_reference = Hash.new { |hash, key| hash[key] = [] }
      @by_key = Hash.new { |hash, key| hash[key] = [] }
      @by_date_amount = Hash.new { |hash, key| hash[key] = [] }
      existing.each do |row|
        @by_reference[row[:reference]] << row if row[:reference].present?
        @by_key[key_for(row)] << row
        @by_date_amount[[row[:date].to_s, amount(row)]] << row
      end
    end

    def classify(incoming)
      occurrences = Hash.new(0)
      incoming.map do |row|
        if row[:reference].present?
          match = @by_reference[row[:reference]].find { |candidate| candidate[:account] == row[:account] }
          next Verdict.new(result: "duplicate", of: match[:id], reason: "bank_reference") if match
        end
        key = key_for(row)
        seen = (occurrences[[row[:account], key]] += 1)
        candidates = @by_key.fetch(key, [])
        same = candidates.select { |candidate| candidate[:account] == row[:account] }
        next Verdict.new(result: "duplicate", of: same[seen - 1][:id], reason: "overlap") if seen <= same.length
        unknown = candidates.select { |candidate| candidate[:account] != row[:account] && (candidate[:account].nil? || row[:account].nil?) }
        if seen - same.length <= unknown.length
          next Verdict.new(result: "review", of: unknown[seen - same.length - 1][:id], reason: "unknown_account")
        end
        merchant = Categorizer.merchant_key(row[:description])
        if merchant
          near = @by_date_amount.fetch([row[:date].to_s, amount(row)], []).find do |candidate|
            candidate[:account] == row[:account] && self.class.description_key(candidate[:description]) != self.class.description_key(row[:description]) &&
              Categorizer.merchant_key(candidate[:description]) == merchant
          end
          next Verdict.new(result: "review", of: near[:id], reason: "near_match") if near
        end
        Verdict.new(result: "new", of: nil, reason: nil)
      end
    end

    private

    def amount(row)
      BigDecimal(row[:amount].to_s)
    end

    def key_for(row)
      [row[:date].to_s, amount(row), self.class.description_key(row[:description])]
    end
  end
end
