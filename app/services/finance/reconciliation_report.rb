module Finance
  # The Reconciliation Center's data (docs/architecture/receipt-capture-and-reconciliation.md §6).
  #
  # Deduplication (ReceiptReconciler) decides whether two records are one purchase. Reconciliation,
  # here, checks whether the ledger agrees with the bank records and the receipts: receipt amounts
  # that differ from the bank charge, charges that look doubled, receipts the bank has not shown yet,
  # entries that need a receipt, refunds without their purchase, transfers counted as spending, and
  # statement balance continuity. Read-only: nothing here changes a record.
  #
  # Cash purchases and receipts younger than STALE_DAYS are never reported as errors. A balance
  # check is reported only where two statements with closing balances bracket a period; the result
  # says "consistent" or the difference, never "fully reconciled".
  class ReconciliationReport
    STALE_DAYS = 10
    LIMIT = 100

    BalanceCheck = Data.define(:account, :from_on, :to_on, :opening, :closing, :movements, :difference) do
      def consistent? = difference.zero?
    end

    attr_reader :user, :today

    def initialize(user, today:)
      @user = user
      @today = today
    end

    def receipts = Receipt.where(user_id: user.id)

    # Receipts a person must decide on: incomplete or uncertain extraction, possible duplicates, suggestions.
    def awaiting_review
      @awaiting_review ||= begin
        suggested = ReceiptMatch.suggested.where(user_id: user.id).select(:receipt_id)
        receipts.where(status: %w[needs_review possible_duplicate]).or(receipts.where(id: suggested))
          .includes(:entry, :bank_account, matches: {finance_transaction: [:bank_account, :statement]}).newest_first.limit(LIMIT).to_a
      end
    end

    def matched
      @matched ||= receipts.where(status: "matched").includes(:entry, matches: {finance_transaction: [:bank_account, :statement]}).order(updated_at: :desc).limit(LIMIT).to_a
    end

    def awaiting_bank
      @awaiting_bank ||= receipts.where(status: "pending_bank_match").includes(:entry).order(:purchased_on).limit(LIMIT).to_a
    end

    def cash = @cash ||= receipts.where(status: "cash").includes(:entry).order(purchased_on: :desc).limit(LIMIT).to_a

    # Not an error: the bank may still post. Shown so a person can check the card statement.
    def stale_receipts = awaiting_bank.select { |receipt| receipt.purchased_on && receipt.purchased_on < today - STALE_DAYS }

    def recently_verified
      @recently_verified ||= ReceiptMatch.confirmed.where(user_id: user.id, decided_by: "user").includes(:receipt, :finance_transaction)
        .order(decided_at: :desc).limit(20).to_a
    end

    # {type => [records]} for everything that does not agree.
    def discrepancies
      @discrepancies ||= {
        amount_mismatch: amount_mismatches, duplicate_charges: duplicate_charges, missing_receipts: missing_receipts,
        refunds_without_purchase: refunds_without_purchase, transfers_as_spending: transfers_as_spending, balance: balance_checks.reject(&:consistent?)
      }
    end

    def discrepancy_count = discrepancies.values.sum(&:length)

    def amount_mismatches
      matched.select { |receipt| %w[amount_mismatch foreign_currency].include?(receipt.verification) }
    end

    # Two bank rows in one account with the same amount and merchant within two days, neither linked as a
    # duplicate already. Could be a real second purchase — listed for a look, never changed.
    def duplicate_charges
      rows = bank_rows.where(kind: "expense").where(booked_on: (today - 400)..today).order(:bank_account_id, :amount, :booked_on, :id)
        .pluck(:id, :bank_account_id, :amount, :booked_on, :original_description)
      linked = TransactionLink.where(user_id: user.id, link_type: "duplicate_of").pluck(:from_transaction_id, :to_transaction_id).flatten.to_set
      pairs = []
      rows.group_by { |_, account, amount| [account, amount] }.each_value do |group|
        group.each_cons(2) do |first, second|
          next if (second[3] - first[3]).abs > 2 || linked.include?(first[0]) || linked.include?(second[0])
          next unless MerchantIdentity.key(first[4]) && MerchantIdentity.key(first[4]) == MerchantIdentity.key(second[4])
          pairs << [first[0], second[0]]
        end
      end
      ids = pairs.flatten.uniq
      entries = Transaction.where(user_id: user.id, id: ids).includes(:bank_account).index_by(&:id)
      pairs.first(LIMIT).map { |a, b| [entries[a], entries[b]] }
    end

    # Entries flagged for tax review need supporting records; others are not expected to have receipts.
    def missing_receipts
      with_receipt = ReceiptMatch.confirmed.where(user_id: user.id).select(:transaction_id)
      Transaction.included.where(user_id: user.id, tax_review: true, kind: "expense").where.not(entry_origin: "receipt").where.not(id: with_receipt)
        .order(booked_on: :desc).limit(LIMIT).to_a
    end

    def refunds_without_purchase
      linked = TransactionLink.where(user_id: user.id, link_type: "refund_of").select(:from_transaction_id)
      with_receipt = ReceiptMatch.confirmed.where(user_id: user.id).select(:transaction_id)
      Transaction.included.where(user_id: user.id, kind: "refund").where.not(id: linked).where.not(id: with_receipt)
        .where(booked_on: (today - 400)..today).order(booked_on: :desc).limit(LIMIT).to_a
    end

    # Money moved between the person's own accounts that is counted as spending (inflates expenses).
    def transfers_as_spending
      bank_rows.where(kind: "expense").where.not("jsonb_exists(user_locked_fields, 'kind')").order(booked_on: :desc).limit(2000).to_a
        .select { |entry| Domain::TRANSFER.match?(entry.original_description) }.first(LIMIT)
    end

    def suspect_income_count
      Transaction.live.where(user_id: user.id, kind: "income").where.not("jsonb_exists(user_locked_fields, 'kind')").includes(:bank_account, statement: :bank_account).to_a
        .count { |entry| Domain.suspect_income(kind: entry.kind, amount: entry.amount, account_type: entry.account_type, description: entry.original_description) }
    end

    # Statement continuity per account: previous closing balance + the bank rows dated after it, up to the
    # next closing date, should equal the next closing balance. Only adjacent statements with both
    # balances are compared; anything else is "not enough data".
    def balance_checks
      @balance_checks ||= user.finance_bank_accounts.includes(:statements).flat_map do |account|
        balances = account.statements.select { |statement| statement.closing_balance && statement.closing_balance_on }.sort_by(&:closing_balance_on)
        balances.each_cons(2).filter_map do |previous, current|
          next if previous.closing_balance_on == current.closing_balance_on
          movements = bank_rows.where(booked_on: (previous.closing_balance_on + 1)..current.closing_balance_on)
            .where(statement_id: account.statements.map(&:id)).sum(:amount)
          # Card and loan statements print the balance owed (positive) while purchases are stored negative.
          movements = -movements if account.liability?
          expected = previous.closing_balance + movements
          BalanceCheck.new(account: account, from_on: previous.closing_balance_on, to_on: current.closing_balance_on, opening: previous.closing_balance,
            closing: current.closing_balance, movements: movements, difference: current.closing_balance - expected)
        end
      end
    end

    # Accounts with at least two statement balances (the only ones a continuity check can speak for).
    def balance_coverage
      user.finance_bank_accounts.includes(:statements).map do |account|
        [account, account.statements.count { |statement| statement.closing_balance && statement.closing_balance_on }]
      end
    end

    private

    # Bank evidence: live rows that came from a statement (not typed, not from a receipt).
    def bank_rows = Transaction.live.where(user_id: user.id).where.not(statement_id: nil)
  end
end
