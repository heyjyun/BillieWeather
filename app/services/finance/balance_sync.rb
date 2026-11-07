require "bigdecimal"

module Finance
  # Only the newest dated observation from each identified cash account contributes.
  class BalanceSync
    def self.statement_balance_available?(user)
      summary(user: user)[:total].present?
    end

    def self.call(user:)
      User.find(user.id).with_lock do
        result = summary(user: user)
        profile = Profile.find_by(user_id: user.id)
        if profile && profile.balance_source != "manual"
          if result[:total]
            profile.assign_attributes(current_balance: result[:total], balance_source: "statement", balance_as_of: result[:as_of_start])
            profile.save! if profile.changed?
          elsif profile.balance_source == "statement"
            profile.update!(current_balance: 0, balance_source: nil, balance_as_of: nil)
          end
        end
        result
      end
    end

    def self.summary(user:)
      statements = Statement.where(user_id: user.id).includes(:bank_account).to_a
      groups = statements.select(&:bank_account_id).group_by(&:bank_account_id)
      today = Time.current.in_time_zone(user.time_zone.presence || "America/Chicago").to_date
      accounts = groups.values.map do |history|
        account = history.first.bank_account
        next unless account && account.user_id == user.id
        undated = history.select { |statement| observation_date(statement).nil? }
        latest = (undated.presence || history).max_by do |statement|
          [observation_date(statement) || Date.new(2101, 1, 1), statement.created_at, statement.id]
        end
        date = observation_date(latest)
        status = if account.kind == "credit"
          "excluded_credit"
        elsif account.kind != "cash"
          "unknown_kind"
        elsif date.nil?
          "missing_date"
        elsif date > today
          "future_date"
        elsif latest.closing_balance.nil? || latest.closing_balance_on.nil? || latest.closing_balance_on < date
          "missing_balance"
        else
          "known"
        end
        {account: account, statement: latest, balance: (latest.closing_balance if status == "known"),
         # Credit accounts: the balance as printed on the latest statement, read as the amount owed.
         credit_balance: (latest.closing_balance if status == "excluded_credit"),
         as_of: latest.closing_balance_on || date, status: status}
      end.compact.sort_by { |row| row[:account].display_name.downcase }
      known = accounts.select { |row| row[:status] == "known" }
      unassigned = statements.reject(&:bank_account_id).sort_by { |statement| [statement.created_at, statement.id] }.reverse
      dates = known.map { |row| row[:as_of] }
      owed = accounts.select { |row| row[:status] == "excluded_credit" && row[:credit_balance] }
      {
        accounts: accounts,
        unassigned_statements: unassigned,
        total: (known.sum(BigDecimal(0)) { |row| row[:balance] } if known.any?),
        credit_total: (owed.sum(BigDecimal(0)) { |row| row[:credit_balance] } if owed.any?),
        credit_count: owed.size,
        complete: known.any? && unassigned.empty? && accounts.all? { |row| row[:status].in?(%w[known excluded_credit]) },
        as_of_start: dates.min,
        as_of_end: dates.max
      }
    end

    def self.observation_date(statement)
      statement.balance_observed_on || statement.closing_balance_on
    end
    private_class_method :observation_date
  end
end
