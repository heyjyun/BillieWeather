require "bigdecimal"

module Finance
  class CashFlowForecast
    class InvalidScenario < StandardError; end
    ENGINES = %w[prophet chronos linear].freeze

    def initialize(user:, days: 30, income_adjustment: 0, expense_adjustment: 0, engine: nil)
      @user = user
      default_engine = ENV["FORECAST_ENGINE"].presence_in(ENGINES) || "prophet"
      @engine = (engine.presence || default_engine).to_s
      raise InvalidScenario, I18n.t("billie.backend.choose_forecast_model") unless ENGINES.include?(@engine)

      @days = Integer(days.to_s, 10)
      @income_adjustment = BigDecimal(income_adjustment.to_s)
      @expense_adjustment = BigDecimal(expense_adjustment.to_s)
      unless @days.between?(1, 90) && [@income_adjustment, @expense_adjustment].all? { |value| value.finite? && value.between?(-100, 1000) }
        raise InvalidScenario, I18n.t("billie.backend.scenario_bounds")
      end
    rescue ArgumentError, TypeError
      raise InvalidScenario, I18n.t("billie.backend.invalid_scenario")
    end

    def to_h
      today = Date.current
      balance_summary = BalanceSync.call(user: @user)
      profile = Profile.find_by(user_id: @user.id)
      current_balance = profile&.current_balance || BigDecimal(0)
      balance_available = !!profile&.balance_available?
      transactions = Transaction.where(user_id: @user.id).included.where(booked_on: (today - 89)..today)
      first_date = transactions.minimum(:booked_on)
      # Historical average: normally the last 90 days up to today. If the data is stale (nothing in
      # those 90 days), use the 90 days ending at the latest transaction instead, so a gap with no
      # uploaded statements is never counted as zero income and spending.
      known = Transaction.where(user_id: @user.id).included.where(booked_on: ..today)
      last_known = known.maximum(:booked_on)
      window_end = (last_known && last_known >= today - 89) ? today : last_known
      avg_scope = window_end ? known.where(booked_on: (window_end - 89)..window_end) : known.none
      avg_first = avg_scope.minimum(:booked_on)
      history_days = avg_first ? (window_end - avg_first).to_i + 1 : 0
      income = avg_scope.where("amount > 0").sum(:amount)
      expenses = -avg_scope.where("amount < 0").sum(:amount)
      income_factor = 1 + @income_adjustment / 100
      expense_factor = 1 + @expense_adjustment / 100
      daily_income = history_days.positive? ? income / history_days * income_factor : BigDecimal(0)
      daily_expenses = history_days.positive? ? expenses / history_days * expense_factor : BigDecimal(0)
      daily_net = daily_income - daily_expenses
      points = balance_available ? (0..@days).map { |day| {date: today + day, balance: (current_balance + daily_net * day).round(2)} } : []
      method = :linear
      @model_notice = nil

      if @engine == "prophet" && (projection = prophet_projection(today))
        method = :prophet
        first_date = projection[:first_date]
        history_days = (today - first_date).to_i + 1
        days = projection[:rows].first(@days)
        daily_income = days.sum { |day| BigDecimal(day.income.to_s) } / @days * income_factor
        daily_expenses = days.sum { |day| BigDecimal(day.expenses.to_s) } / @days * expense_factor
        points = balance_available ? prophet_points(days, current_balance, today, income_factor, expense_factor) : []
      elsif @engine == "chronos" && (projection = chronos_projection(transactions, first_date, today, current_balance, balance_available, profile&.currency || "USD"))
        method = :chronos
        # BillieForecast has already applied the scenario percentages and cent rounding.
        days = projection.fetch("points")
        daily_income = days.sum { |day| BigDecimal(day.fetch("income").to_s) } / @days
        daily_expenses = days.sum { |day| BigDecimal(day.fetch("expenses").to_s) } / @days
        points = [{date: today, balance: current_balance.round(2)}] + days.map do |day|
          {date: Date.iso8601(day.fetch("date")), balance: BigDecimal(day.fetch("balance").to_s)}
        end
        @model_notice = Array(projection["warnings"]).map { |warning| localized_model_warning(warning) }.join(" ").presence
      end

      assumptions = [
        I18n.t("billie.backend.forecast_balance_assumption"),
        I18n.t("billie.backend.forecast_snapshot_assumption"),
        (case method
         when :prophet
           I18n.t("billie.backend.forecast_prophet_assumption", days: history_days)
         when :chronos
           I18n.t("billie.backend.forecast_chronos_assumption", days: history_days)
         else
           I18n.t("billie.backend.forecast_average_assumption", days: history_days)
         end),
        I18n.t("billie.backend.forecast_exclusions"),
        I18n.t("billie.backend.forecast_adjustments", income: @income_adjustment.to_s("F"), expense: @expense_adjustment.to_s("F")),
        I18n.t("billie.backend.forecast_unknowns")
      ]
      assumptions << I18n.t("billie.backend.forecast_no_transactions") unless last_known
      if method == :linear && last_known && last_known < today - 89
        assumptions << I18n.t("billie.backend.forecast_stale_history", date: I18n.l(last_known, format: I18n.locale.to_s == "zh-CN" ? "%Y年%-m月%-d日" : "%b %-d, %Y"))
      end
      assumptions << I18n.t("billie.backend.forecast_no_balance") unless balance_available
      assumptions << I18n.t("billie.backend.forecast_partial_balance") if balance_available && profile.balance_source == "statement" && !balance_summary[:complete]

      {
        currency: profile&.currency || "USD",
        current_balance: (current_balance if balance_available),
        projected_balance: points.last&.fetch(:balance),
        balance_available: balance_available,
        balance_complete: balance_summary[:complete],
        daily_income: daily_income.round(2),
        daily_expenses: daily_expenses.round(2),
        history_days: history_days,
        days: @days,
        has_history: last_known.present? || first_date.present?,
        method: method,
        requested_engine: @engine.to_sym,
        model_notice: @model_notice,
        income_adjustment: @income_adjustment,
        expense_adjustment: @expense_adjustment,
        points: points,
        assumptions: assumptions
      }
    end

    private

    def localized_model_warning(warning)
      key = {
        "Fewer than 30 days of history; recurring monthly patterns may be missed." => "chronos_short_month",
        "Negative income or expense predictions were clipped to zero." => "chronos_clipped_predictions",
        "Average mode is active; this forecast was not produced by Chronos-2." => "chronos_average_active"
      }[warning]
      key ? I18n.t("billie.backend.#{key}") : warning
    end

    def prophet_projection(today)
      scope = Transaction.where(user_id: @user.id).included.where(booked_on: ..today)
      daily_income = scope.where("amount > 0").group(:booked_on).sum(:amount)
      daily_expenses = scope.where("amount < 0").group(:booked_on).sum(:amount).transform_values(&:-@)
      unless ProphetProjector.eligible?(daily_income, daily_expenses, today: today)
        @model_notice = I18n.t("billie.backend.prophet_short_history", history_days: ProphetProjector::MIN_HISTORY_DAYS, active_days: ProphetProjector::MIN_ACTIVE_DAYS)
        return
      end

      stamp = scope.pick(Arel.sql("COUNT(*)"), Arel.sql("MAX(updated_at)"))
      cache_key = ["finance/prophet/v1", @user.id, today.iso8601, *stamp.map(&:to_s)]
      rows = ProphetProjector.new(daily_income: daily_income, daily_expenses: daily_expenses, today: today, cache_key: cache_key).call
      {rows: rows, first_date: (daily_income.keys + daily_expenses.keys).min}
    rescue => e
      Rails.logger.error("Prophet forecast failed, using historical average (#{e.class}).")
      @model_notice = I18n.t("billie.backend.prophet_unavailable")
      nil
    end

    def chronos_projection(transactions, first_date, today, current_balance, balance_available, currency)
      unless balance_available
        @model_notice = I18n.t("billie.backend.chronos_no_balance")
        return
      end
      unless first_date
        @model_notice = I18n.t("billie.backend.chronos_no_history")
        return
      end
      if (today - first_date).to_i + 1 < 3
        @model_notice = I18n.t("billie.backend.chronos_short_history")
        return
      end

      income = transactions.where("amount > 0").group(:booked_on).sum(:amount)
      expenses = transactions.where("amount < 0").group(:booked_on).sum(:amount).transform_values(&:-@)
      history = (first_date..today).map do |day|
        {date: day.iso8601, income: income.fetch(day, BigDecimal(0)).to_s("F"),
         expenses: expenses.fetch(day, BigDecimal(0)).to_s("F")}
      end
      BillieForecastClient.new.call(history: history, starting_balance: current_balance,
        days: @days, currency: currency, income_adjustment: @income_adjustment,
        expense_adjustment: @expense_adjustment)
    rescue => error
      Rails.logger.error("Chronos-2 forecast failed, using historical average (#{error.class}).")
      @model_notice = I18n.t("billie.backend.chronos_unavailable")
      nil
    end

    def prophet_points(days, start_balance, today, income_factor, expense_factor)
      mid = low = high = start_balance
      points = [{date: today, balance: start_balance.round(2), lower: start_balance.round(2), upper: start_balance.round(2)}]
      days.each do |day|
        mid += BigDecimal((day.income * income_factor - day.expenses * expense_factor).to_s)
        # Pessimistic band: low income and high spending; optimistic band: the reverse.
        low += BigDecimal((day.income_lower * income_factor - day.expenses_upper * expense_factor).to_s)
        high += BigDecimal((day.income_upper * income_factor - day.expenses_lower * expense_factor).to_s)
        points << {date: day.date, balance: mid.round(2), lower: low.round(2), upper: high.round(2)}
      end
      points
    end
  end
end
