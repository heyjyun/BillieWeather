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

  test "transfers excluded future and stale transactions do not drive forecasts" do
    transaction("1000", Date.current - 100)
    transaction("-1000", Date.current + 1)
    transaction("-1000", Date.current - 1, category: "Transfers")
    transaction("-1000", Date.current - 1, excluded: true)
    result = Finance::CashFlowForecast.new(user: @user).to_h
    assert_equal 0, result[:history_days]
    refute result[:has_history]
    assert_equal BigDecimal("1000"), result[:projected_balance]
  end

  test "invalid and extreme scenarios return validation errors" do
    [{days: "2.5"}, {days: 0}, {days: 91}, {income_adjustment: "NaN"}, {expense_adjustment: -101}].each do |options|
      assert_raises(Finance::CashFlowForecast::InvalidScenario) { Finance::CashFlowForecast.new(user: @user, **options) }
    end
  end

  private

  def transaction(amount, date, category: "Income", excluded: false)
    Finance::Transaction.create!(user: @user, statement: @statement, booked_on: date,
      description: "Test", amount: amount, category: category, excluded: excluded)
  end
end
