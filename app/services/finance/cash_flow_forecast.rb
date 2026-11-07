require "bigdecimal"

module Finance
  class CashFlowForecast
    class InvalidScenario < StandardError; end

    def initialize(user:, days: 30, income_adjustment: 0, expense_adjustment: 0)
      @user = user
      @days = Integer(days.to_s, 10)
      @income_adjustment = BigDecimal(income_adjustment.to_s)
      @expense_adjustment = BigDecimal(expense_adjustment.to_s)
      unless @days.between?(1, 90) && [@income_adjustment, @expense_adjustment].all? { |value| value.finite? && value.between?(-100, 1000) }
        raise InvalidScenario, "Choose 1–90 days and adjustments from -100% to 1000%."
      end
    rescue ArgumentError, TypeError
      raise InvalidScenario, "Enter valid days and percentage adjustments."
    end

    def to_h
      today = Date.current
      profile = Profile.find_by(user_id: @user.id)
      current_balance = profile&.current_balance || BigDecimal("0")
      transactions = Transaction.where(user_id: @user.id).included.where(booked_on: (today - 89)..today)
      first_date = transactions.minimum(:booked_on)
      history_days = first_date ? (today - first_date).to_i + 1 : 0
      income = transactions.where("amount > 0").sum(:amount)
      expenses = -transactions.where("amount < 0").sum(:amount)
      daily_income = history_days.positive? ? income / history_days : BigDecimal("0")
      daily_expenses = history_days.positive? ? expenses / history_days : BigDecimal("0")
      daily_income *= 1 + @income_adjustment / 100
      daily_expenses *= 1 + @expense_adjustment / 100
      daily_net = daily_income - daily_expenses
      points = (0..@days).map { |day| {date: today + day, balance: (current_balance + daily_net * day).round(2)} }

      assumptions = [
        "Starting cash is the current balance you entered; it is not inferred from statement transactions.",
        "Uses average daily income and spending from the last #{history_days} calendar days of available history (maximum 90 days), including days with no transactions.",
        "Transfers and transactions marked excluded are omitted. Future-dated transactions are not historical observations.",
        "Income adjustment: #{@income_adjustment.to_s('F')}%; spending adjustment: #{@expense_adjustment.to_s('F')}%.",
        "This straight-line estimate does not know future bill dates, unexpected expenses, interest, or tax liabilities."
      ]
      assumptions << "No transactions in the past 90 days: the projection stays at your entered balance." unless first_date

      {
        currency: profile&.currency || "USD",
        current_balance: current_balance,
        projected_balance: points.last[:balance],
        daily_income: daily_income.round(2),
        daily_expenses: daily_expenses.round(2),
        history_days: history_days,
        days: @days,
        has_history: first_date.present?,
        income_adjustment: @income_adjustment,
        expense_adjustment: @expense_adjustment,
        points: points,
        assumptions: assumptions
      }
    end
  end
end
