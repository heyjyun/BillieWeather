require "test_helper"

class Finance::CashFlowForecastTest < ActiveSupport::TestCase
  setup do
    @user = create(:user)
    Finance::Profile.create!(user: @user, current_balance: "1000")
    @statement = Finance::Statement.create!(user: @user, filename: "test.csv", currency: "USD", sha256: "a" * 64, transaction_count: 2)
  end

  test "uses calendar days including quiet days and projects from entered cash balance" do
    travel_to Time.zone.local(2026, 11, 6, 12) do
      transaction("300", Date.current - 9)
      transaction("-100", Date.current)
      result = Finance::CashFlowForecast.new(user: @user, days: 30).to_h
      assert_equal 10, result[:history_days]
      assert_equal BigDecimal("30"), result[:daily_income]
      assert_equal BigDecimal("10"), result[:daily_expenses]
      assert_equal BigDecimal("1600"), result[:projected_balance]
      assert_equal BigDecimal("1000"), result[:points].first[:balance]
      assert_equal Date.current + 30, result[:points].last[:date]
    end
  end

  test "scenario percentages change income and expense streams independently" do
    transaction("300", Date.current - 9)
    transaction("-100", Date.current)
    result = Finance::CashFlowForecast.new(user: @user, days: 10, income_adjustment: -100, expense_adjustment: 100).to_h
    assert_equal BigDecimal("0"), result[:daily_income]
    assert_equal BigDecimal("20"), result[:daily_expenses]
    assert_equal BigDecimal("800"), result[:projected_balance]
  end

  test "transfers excluded and future transactions do not drive forecasts" do
    transaction("-1000", Date.current + 1)
    transaction("-1000", Date.current - 1, category: "Transfers")
    transaction("-1000", Date.current - 1, excluded: true)
    result = Finance::CashFlowForecast.new(user: @user).to_h
    assert_equal 0, result[:history_days]
    refute result[:has_history]
    assert_equal BigDecimal("1000"), result[:projected_balance]
  end

  test "historical average uses the latest available data instead of counting a stale gap as zero" do
    travel_to Time.zone.local(2026, 11, 6, 12) do
      transaction("300", Date.current - 400)
      transaction("-100", Date.current - 391)
      transaction("999", Date.current - 600) # older than 90 days before the latest transaction
      result = Finance::CashFlowForecast.new(user: @user, days: 30, engine: "linear").to_h
      assert_equal 10, result[:history_days]
      assert_equal BigDecimal("30"), result[:daily_income]
      assert_equal BigDecimal("10"), result[:daily_expenses]
      assert_equal BigDecimal("1600"), result[:projected_balance]
      assert result[:assumptions].any? { |a| a.include?("latest transaction is on") }
    end
  end

  test "invalid and extreme scenarios return validation errors" do
    [{days: "2.5"}, {days: 0}, {days: 91}, {income_adjustment: "NaN"}, {expense_adjustment: -101}].each do |options|
      assert_raises(Finance::CashFlowForecast::InvalidScenario) { Finance::CashFlowForecast.new(user: @user, **options) }
    end
  end

  test "short history falls back to the straight-line method" do
    transaction("300", Date.current - 9)
    result = Finance::CashFlowForecast.new(user: @user, days: 30).to_h
    assert_equal :linear, result[:method]
    refute result[:points].first.key?(:lower)
  end

  test "enough personal history uses prophet with a likely range" do
    travel_to Time.zone.local(2026, 11, 6, 12) do
      (0..119).each do |offset|
        date = Date.current - offset
        transaction("2000", date) if date.day == 1
        transaction("-#{date.wday >= 5 ? 90 : 40}", date, category: "Food & dining")
      end
      result = Finance::CashFlowForecast.new(user: @user, days: 30).to_h
      assert_equal :prophet, result[:method]
      assert_equal 31, result[:points].size
      assert_equal Date.current, result[:points].first[:date]
      assert_equal Date.current + 30, result[:points].last[:date]
      assert_equal BigDecimal("1000"), result[:points].first[:balance]
      assert result[:points].all? { |pt| pt[:lower] <= pt[:balance] + 0.01 && pt[:balance] <= pt[:upper] + 0.01 }
      assert_operator result[:daily_expenses], :>, 0

      doubled = Finance::CashFlowForecast.new(user: @user, days: 30, expense_adjustment: 100).to_h
      assert_in_delta result[:daily_expenses] * 2, doubled[:daily_expenses], 0.02
    end
  end

  test "FORECAST_ENGINE=linear disables prophet" do
    (0..119).each { |offset| transaction("-10", Date.current - offset, category: "Food & dining") }
    ENV["FORECAST_ENGINE"] = "linear"
    assert_equal :linear, Finance::CashFlowForecast.new(user: @user).to_h[:method]
  ensure
    ENV.delete("FORECAST_ENGINE")
  end

  private

  def transaction(amount, date, category: "Income", excluded: false)
    Finance::Transaction.create!(user: @user, statement: @statement, booked_on: date,
      description: "Test", amount: amount, category: category, excluded: excluded)
  end
end
