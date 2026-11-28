module Finance
  # Each method backs one independently loaded section. Only aggregated time series and the
  # six recent descriptions leave the server. All relations start with the authenticated owner.
  class OverviewData
    SECTIONS = %w[flow position spending recent bills budget insight forecast].freeze

    def initialize(user:, profile:, accounts:, account:, currency:, period:, today:)
      @user, @profile, @accounts, @account = user, profile, accounts, account
      @currency, @period, @today = currency, period, today
    end

    def self.in_currency(rows, currency, base_currency)
      rows.left_outer_joins(:statement, :bank_account).where(
        "COALESCE(finance_statements.currency, finance_bank_accounts.currency, ?) = ?", base_currency, currency
      )
    end

    def flow
      scope = @period.filtered? ? rows.where(booked_on: @period.previous_start..@period.end_date) : rows
      dates = scope.distinct.pluck(:booked_on).sort
      sums = scope.included.group(:booked_on, :kind).sum(:amount)
      dates.map do |date|
        {date: date, income: cents(sums[[date, "income"]]), expenses: -cents(sums[[date, "expense"]]) - cents(sums[[date, "refund"]]),
         counted: Domain::COUNTED_KINDS.any? { |kind| sums.key?([date, kind]) }}
      end
    end

    def position
      scoped = scoped_accounts
      holdings = balances.map do |row|
        a, amount = row.values_at(:account, :amount)
        {type: a.account_type, liability: a.liability?, included: a.include_in_net_worth, archived: a.archived?, balance: (cents(amount) unless amount.nil?)}
      end
      legacy_cash = !@account && @currency == @profile.currency
      # A manually entered overall cash snapshot takes precedence over imported observations.
      # With manual ledger cash accounts it could overlap, so use those account balances instead.
      override = legacy_cash && @profile.manual_balance? && scoped.none? { |a| a.manual? && liquid?(a) }
      extra = @profile.cash_on_hand if legacy_cash && (@profile.cash_on_hand_on || @profile.cash_on_hand.to_d.positive?)
      {holdings: holdings, extraCash: (cents(extra) if extra), cashOverride: (cents(@profile.current_balance) + cents(extra) if override)}
    end

    def spending
      tree = CategoryTree.new(@user)
      in_period.included.expense_kind.group(:category).sum(:amount).map do |name, amount|
        {path: tree.path_names(name).map { |key| {name: key, label: DefaultCategories.label(key)} }, amount: -cents(amount)}
      end
    end

    def recent
      in_period.recent_first.includes(:bank_account).limit(6).map do |r|
        {id: r.id, date: r.booked_on, name: r.description, category: DefaultCategories.label(r.category),
         account: r.bank_account&.display_name, amount: cents(r.amount)}
      end
    end

    def bills
      accounts = @accounts.index_by(&:id)
      @user.finance_recurring_rules.where(paused: false).flat_map do |rule|
        template = rule.template
        account = accounts[template["account_id"].to_i]
        next [] unless account && template["kind"] == "expense"
        next [] if @account && @account != account
        next [] unless (account.currency.presence || @profile.currency) == @currency
        rule.upcoming(91, from: @today, through: @today + 90).map do |date|
          {date: date, name: rule.name, account: account.display_name, amount: cents(template.fetch("amount").to_d)}
        end
      end.sort_by { |r| [r[:date], r[:name]] }
    end

    def budget
      return if @account || @currency != @profile.currency
      # Category/project budgets can overlap. Only an unambiguous ledger-wide monthly limit applies.
      limits = @user.finance_budgets.where(category: [nil, ""], project_id: nil, period: "month").limit(2).to_a
      return unless limits.one?
      from, to = Domain.period_bounds(@today, "month", @user.finance_books.find_by(default_book: true)&.month_start_day || 1)
      cents(limits.first.amount + rows.included.expense_kind.where(booked_on: from..to).sum(:amount))
    end

    def insight
      return if @account || @period.filtered? || @currency != @profile.currency || @accounts.any? { |a| a.currency.present? && a.currency != @currency }
      item = @user.finance_insights.general.where(source: "openai").latest_first.first
      return unless item && item.content["summary"].present?
      return if @user.finance_statements.where.not(currency: @currency).exists?
      {text: item.content["summary"].truncate(450), date: item.generated_at.in_time_zone(@user.time_zone).to_date}
    end

    # Project movements from a zero baseline; the client adds the same scoped available funds
    # shown on its balance card. The existing local average engine has no provider dependency.
    def forecast
      history = rows.included.where(booked_on: (@today - 89)..@today)
      days = history.distinct.pluck(:booked_on).sort
      return [] if days.size < 3 || days.last - days.first < 13
      daily = history.sum(:amount) / ((@today - days.first).to_i + 1)
      CashFlowForecast.linear_points(@today, 90, 0, daily).map { |p| {date: p[:date], balance: cents(p[:balance])} }
    end

    # Each account in this currency with the balance the overview uses today (nil when unknown).
    # `observation` is the latest statement row when the balance comes from a statement.
    def balances
      @balances ||= begin
        scoped = scoped_accounts
        movements = rows.where(booked_on: ..@today).group(:bank_account_id).sum(:amount)
        mixed_accounts = @user.finance_transactions.live.joins(:statement, :bank_account)
          .where("finance_statements.currency <> COALESCE(finance_bank_accounts.currency, ?)", @profile.currency)
          .distinct.pluck(:bank_account_id)
        observed = (scoped.any? { |a| !a.manual? }) ? BalanceSync.summary(user: @user)[:accounts].index_by { |row| row[:account].id } : {}
        scoped.map do |a|
          from_statement = false
          amount = if (a.balance_pending? && a.manual?) || mixed_accounts.include?(a.id) || (a.opening_balance_on && a.opening_balance_on > @today)
            nil
          elsif a.balance_snapshot?
            a.balance(as_of: @today)
          elsif a.manual? || a.opening_balance_on.present?
            a.opening_balance + movements.fetch(a.id, 0)
          else
            from_statement = true
            statement_balance(a, observed[a.id])
          end
          {account: a, amount: amount, observation: (observed[a.id] if from_statement && !amount.nil?)}
        end
      end
    end

    private

    def scoped_accounts
      @accounts.select { |a| (@account.nil? || a == @account) && (a.currency.presence || @profile.currency) == @currency }
    end

    def cents(amount) = (amount.to_d * 100).round.to_i

    def rows
      @rows ||= begin
        scope = self.class.in_currency(@user.finance_transactions.live, @currency, @profile.currency)
        @account ? scope.where(bank_account_id: @account.id) : scope
      end
    end

    def in_period
      @period.filtered? ? rows.where(booked_on: @period.start_date..@period.end_date) : rows
    end

    def liquid?(account) = %w[cash checking savings payment_app].include?(account.account_type)

    def statement_balance(account, row)
      return unless row && row[:as_of] && row[:as_of] <= @today && row[:statement].currency == @currency
      if account.liability?
        return unless row[:credit_balance] && row[:statement].closing_balance_on == row[:as_of]
        opening = -row[:credit_balance]
      else
        return unless row[:status] == "known"
        opening = row[:balance]
      end
      opening + rows.where(bank_account_id: account.id, booked_on: (row[:as_of] + 1)..@today).sum(:amount)
    end
  end
end
