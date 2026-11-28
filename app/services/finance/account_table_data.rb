module Finance
  # Rows and per-currency positions for the shared Accounts & Assets table
  # (clients/universal/src/accounts). Read-only. Balances and positions come from OverviewData, so
  # this page and the dashboard always agree. Amounts are integer cents in each account's currency.
  #
  # Balance dates are only ever real ones: a confirmed opening balance, the latest balance
  # adjustment, or the latest dated statement when it supplies or matches the balance. A record's
  # updated_at is never used as a balance date.
  class AccountTableData
    def initialize(user:, profile:, today:)
      @user, @profile, @today = user, profile, today
      @accounts = user.finance_bank_accounts.ordered.to_a
    end

    def currencies
      ([@profile.currency] + @accounts.map { |a| currency_of(a) }).uniq
    end

    def positions
      currencies.map { |code| {currency: code, position: overview(code).position} }
    end

    def rows
      amounts = currencies.flat_map { |code| overview(code).balances }.index_by { |row| row[:account].id }
      live = @user.finance_transactions.live
      last_entry = live.group(:bank_account_id).maximum(:booked_on)
      last_adjustment = live.where(kind: "adjustment", booked_on: ..@today).group(:bank_account_id).maximum(:booked_on)
      used = live.distinct.pluck(:bank_account_id).to_set | @user.finance_statements.distinct.pluck(:bank_account_id) |
        @user.finance_receipts.where.not(bank_account_id: nil).distinct.pluck(:bank_account_id)
      differs = BalanceSync.reconciliation_evidence(@user)
      statements = (@accounts.any? { |a| a.account_type.in?(%w[checking savings]) }) ? BalanceSync.summary(user: @user)[:accounts].index_by { |row| row[:account].id } : {}

      @accounts.map do |account|
        row = amounts[account.id] || {}
        amount = row[:amount]
        candidates = []
        if !account.balance_pending? && account.opening_balance_on && account.opening_balance_on <= @today
          candidates << [account.opening_balance_on, (account.balance_snapshot? || account.manual?) ? "manual" : "statement"]
        end
        candidates << [last_adjustment[account.id], "manual"] if last_adjustment[account.id]
        if (observation = row[:observation])
          candidates << [observation[:as_of], "statement"]
        elsif statement_matches?(account, statements[account.id])
          candidates << [statements[account.id][:as_of], "statement"]
        end
        confirmed_on, confirmed_by = candidates.max_by { |date, by| [date, (by == "manual") ? 1 : 0] }
        {
          id: account.id.to_s, name: account.display_name, institution: account.bank_name.presence, last4: account.last4.presence,
          type: account.account_type, liability: account.liability?, currency: currency_of(account),
          balance: (cents(amount) unless amount.nil?), archived: account.archived?, includeInNetWorth: account.include_in_net_worth,
          origin: account.manual? ? "manual" : "imported", confirmedOn: confirmed_on&.iso8601, confirmedBy: confirmed_by,
          lastEntryOn: last_entry[account.id]&.iso8601, statementDiffers: differs.key?(account.id),
          creditLimit: (cents(account.credit_limit) if account.credit_limit), sortOrder: account.sort_order, canDelete: !used.include?(account.id)
        }
      end
    end

    private

    def currency_of(account) = account.currency.presence || @profile.currency

    def overview(code)
      (@overviews ||= {})[code] ||= OverviewData.new(user: @user, profile: @profile, accounts: @accounts, account: nil, currency: code, period: nil, today: @today)
    end

    # The latest dated cash statement equals what the ledger says on that day.
    def statement_matches?(account, row)
      return false unless row && row[:status] == "known" && row[:as_of] <= @today && !account.balance_pending?
      return false if account.balance_snapshot? && account.opening_balance_on > row[:as_of]
      return false if account.currency.present? && account.currency != row[:statement].currency
      account.balance(as_of: row[:as_of]) == row[:balance]
    end

    def cents(amount) = (amount.to_d * 100).round.to_i
  end
end
