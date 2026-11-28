module Finance
  class TransferReview
    HINT = /transfer|xfer|card payment|autopay|转账|轉帳|还款|還款|振替|이체|transferencia/i
    RELATIONS = %w[transfer card_payment].freeze

    def initialize(user)
      @user = user
    end

    def candidates
      entries = @user.finance_transactions.live.where(entry_origin: "import", excluded: false)
        .joins(:bank_account).includes(:bank_account).where(finance_bank_accounts: {archived_at: nil})
        .order(booked_on: :desc, id: :desc).limit(250).to_a
      entries.reject! { |e| (e.user_locked_fields & %w[kind category account]).any? }
      ids = entries.map(&:id)
      links = @user.finance_transaction_links.where(link_type: RELATIONS + ["refund_of", "duplicate_of"])
        .where("from_transaction_id IN (:ids) OR to_transaction_id IN (:ids)", ids: ids)
        .pluck(:from_transaction_id, :to_transaction_id, :status)
      taken = links.select { |_, _, status| status == "confirmed" }.flat_map { |a,b,_| [a,b] }.to_set
      rejected = links.select { |_, _, status| status == "rejected" }.map { |a,b,_| [a,b] }.to_set
      pool = entries.reject { |row| taken.include?(row.id) }.group_by { |row| row.amount }
      pairs = entries.select { |row| row.amount.negative? && !taken.include?(row.id) }.filter_map do |out|
        matches = Array(pool[-out.amount]).select do |incoming|
          out.bank_account_id != incoming.bank_account_id && out.bank_account.currency == incoming.bank_account.currency &&
            (out.booked_on - incoming.booked_on).abs <= 3 && !rejected.include?([out.id,incoming.id]) &&
            [out,incoming].any? { |r| RELATIONS.include?(r.kind) || HINT.match?(r.original_description) }
        end
        [out,matches.first] if matches.one?
      end
      frequencies = pairs.map { |_,row| row.id }.tally
      pairs.select { |_,row| frequencies[row.id] == 1 }
    end

    def self.revision(pair)
      Digest::SHA256.hexdigest(pair.map { |row| [row.id,row.updated_at.iso8601(6),row.bank_account_id,row.bank_account.account_type,row.amount.to_s("F"),row.kind] }.to_json)
    end

    def decide(revision, decision)
      raise Ledger::Invalid, "invalid_entry" unless %w[confirm reject].include?(decision)
      @user.with_lock do
        pair = candidates.find { |rows| self.class.revision(rows) == revision }
        raise Ledger::Invalid, "not_found" unless pair
        out, incoming = pair
        kind = Domain.transfer_kind(incoming.bank_account.account_type)
        if decision == "confirm"
          ledger = Ledger.new(@user)
          pair.each { |row| ledger.update(row, kind: kind) }
        end
        link = @user.finance_transaction_links.find_or_initialize_by(from_transaction: out, to_transaction: incoming, link_type: kind)
        link.update!(status: decision == "confirm" ? "confirmed" : "rejected", decided_by: "user")
        AuditEvent.record!(user: @user, action: "update", subject: link, changes: {decision: decision})
      end
    end
  end
end
