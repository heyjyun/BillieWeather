require "prophet"

module Finance
  # Forecasts daily income and spending for ONE user with Prophet.
  #
  # Income and spending are modelled as two separate non-negative daily series so the
  # scenario sliders (income % / spending %) can be applied independently afterwards.
  # Fitting always covers MAX_HORIZON days and is cached, so changing the horizon or
  # the scenario percentages never triggers a refit.
  class ProphetProjector
    MAX_HORIZON = 90
    MIN_HISTORY_DAYS = 60 # calendar span between first and last observation
    MIN_ACTIVE_DAYS = 10 # days that actually had a transaction
    INTERVAL_WIDTH = 0.8

    Day = Struct.new(:date, :income, :income_lower, :income_upper, :expenses, :expenses_lower, :expenses_upper, keyword_init: true)

    # daily_income / daily_expenses: {Date => positive Numeric} (days without activity may be absent)
    def self.eligible?(daily_income, daily_expenses, today:)
      dates = (daily_income.keys + daily_expenses.keys).uniq
      dates.size >= MIN_ACTIVE_DAYS && (today - dates.min).to_i + 1 >= MIN_HISTORY_DAYS
    end

    def initialize(daily_income:, daily_expenses:, today:, cache_key: nil)
      @income = daily_income
      @expenses = daily_expenses
      @today = today
      @cache_key = cache_key
    end

    # Returns an array of MAX_HORIZON Day structs for today+1 .. today+MAX_HORIZON.
    def call
      rows = @cache_key ? Rails.cache.fetch(@cache_key, expires_in: 12.hours) { compute } : compute
      rows.map { |row| Day.new(**row.symbolize_keys.merge(date: Date.iso8601(row["date"] || row[:date]))) }
    end

    private

    def compute
      first_date = (@income.keys + @expenses.keys).min
      income = predict(@income, first_date)
      expenses = predict(@expenses, first_date)
      (0...MAX_HORIZON).map do |i|
        {
          "date" => (@today + i + 1).iso8601,
          "income" => income[:yhat][i], "income_lower" => income[:lower][i], "income_upper" => income[:upper][i],
          "expenses" => expenses[:yhat][i], "expenses_lower" => expenses[:lower][i], "expenses_upper" => expenses[:upper][i]
        }
      end
    end

    def predict(series, first_date)
      return {yhat: Array.new(MAX_HORIZON, 0.0), lower: Array.new(MAX_HORIZON, 0.0), upper: Array.new(MAX_HORIZON, 0.0)} if series.empty?

      # Fill quiet days with 0 so Prophet sees the true daily rhythm.
      dates = (first_date..@today).to_a
      frame = Rover::DataFrame.new({"ds" => dates, "y" => dates.map { |d| series.fetch(d, 0).to_f }})
      model = Prophet.new(
        yearly_seasonality: false, # too little history per user to learn a yearly cycle
        weekly_seasonality: true,
        daily_seasonality: false,
        interval_width: INTERVAL_WIDTH
      )
      model.add_seasonality(name: "monthly", period: 30.5, fourier_order: 3) # pay day, rent, bills
      model.fit(frame)
      forecast = model.predict(model.make_future_dataframe(periods: MAX_HORIZON, include_history: false))
      # A daily income or spending amount can't be negative.
      {
        yhat: forecast["yhat"].to_a.map { |v| [v, 0.0].max },
        lower: forecast["yhat_lower"].to_a.map { |v| [v, 0.0].max },
        upper: forecast["yhat_upper"].to_a.map { |v| [v, 0.0].max }
      }
    end
  end
end
