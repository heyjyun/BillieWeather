require "test_helper"
require_relative "../../support/billie_method_stub"

class Finance::ForecastEngineSelectionTest < ActiveSupport::TestCase
  include BillieMethodStub

  setup do
    travel_to Time.zone.local(2026, 11, 6, 12)
    @previous_engine = ENV["FORECAST_ENGINE"]
    ENV.delete("FORECAST_ENGINE")
    @user = create(:user)
    @profile = Finance::Profile.create!(user: @user, current_balance: "1000", balance_source: "manual")
    @statement = statement_for(@user, "a")
  end

  teardown do
    @previous_engine.nil? ? ENV.delete("FORECAST_ENGINE") : ENV["FORECAST_ENGINE"] = @previous_engine
    travel_back
  end

  test "explicit linear bypasses both model providers even with eligible history" do
    add_prophet_history

    stub_method(Finance::ProphetProjector, :eligible?, ->(*) { flunk "Linear must not evaluate Prophet" }) do
      stub_method(Finance::BillieForecastClient, :new, ->(*) { flunk "Linear must not contact Chronos" }) do
        result = Finance::CashFlowForecast.new(user: @user, engine: "linear", days: 2).to_h

        assert_equal :linear, result[:requested_engine]
        assert_equal :linear, result[:method]
        assert_nil result[:model_notice]
        assert_equal 3, result[:points].length
      end
    end
  end

  test "chronos receives only this users included daily history with quiet days zero filled" do
    transaction("100", Date.current - 2)
    transaction("25", Date.current - 2)
    transaction("-10", Date.current - 2)
    transaction("-30", Date.current)
    transaction("999", Date.current - 1, excluded: true)
    transaction("-777", Date.current - 1, category: "Transfers")
    transaction("888", Date.current + 1)
    transaction("777", Date.current - 90)
    other = create(:user)
    other_statement = statement_for(other, "b")
    Finance::Transaction.create!(user: other, statement: other_statement, booked_on: Date.current - 1,
      description: "Other user's private payroll", amount: 9999, category: "Income")
    captured = nil

    with_chronos(->(**arguments) {
      captured = arguments
      chronos_response
    }) do
      result = Finance::CashFlowForecast.new(user: @user, engine: "chronos", days: 2).to_h
      assert_equal :chronos, result[:requested_engine]
      assert_equal :chronos, result[:method]
      assert_equal 3, result[:history_days]
    end

    normalized = captured.fetch(:history).map do |row|
      row = row.stringify_keys
      [Date.iso8601(row.fetch("date").to_s), BigDecimal(row.fetch("income").to_s), BigDecimal(row.fetch("expenses").to_s)]
    end
    assert_equal [
      [Date.current - 2, BigDecimal(125), BigDecimal(10)],
      [Date.current - 1, BigDecimal(0), BigDecimal(0)],
      [Date.current, BigDecimal(0), BigDecimal(30)]
    ], normalized
    assert_equal BigDecimal(1000), BigDecimal(captured.fetch(:starting_balance).to_s)
    assert_equal 2, captured.fetch(:days)
    assert_equal "USD", captured.fetch(:currency)
    assert_equal %w[date expenses income], captured.fetch(:history).first.keys.map(&:to_s).sort
  end

  test "chronos returned scenario adjustments are not applied a second time" do
    transaction("100", Date.current - 2)
    captured = nil

    with_chronos(->(**arguments) {
      captured = arguments
      chronos_response
    }) do
      result = Finance::CashFlowForecast.new(user: @user, engine: "chronos", days: 2,
        income_adjustment: 100, expense_adjustment: 100).to_h

      assert_equal :chronos, result[:method]
      assert_equal BigDecimal(20), result[:daily_income]
      assert_equal BigDecimal(5), result[:daily_expenses]
      assert_equal BigDecimal(1000), result[:points].first.fetch(:balance)
      assert_equal BigDecimal(1015), result[:points][1].fetch(:balance)
      assert_equal BigDecimal(1030), result[:projected_balance]
      assert_equal Date.current + 2, result[:points].last.fetch(:date)
      assert_equal 3, result[:points].length
    end

    assert_equal BigDecimal(100), BigDecimal(captured.fetch(:income_adjustment).to_s)
    assert_equal BigDecimal(100), BigDecimal(captured.fetch(:expense_adjustment).to_s)
  end

  test "unavailable chronos visibly falls back while preserving the requested engine" do
    transaction("100", Date.current - 2)

    with_chronos(->(**) { raise Finance::BillieForecastClient::Unavailable, "Forecast service unavailable" }) do
      result = Finance::CashFlowForecast.new(user: @user, engine: "chronos", days: 2).to_h

      assert_equal :chronos, result[:requested_engine]
      assert_equal :linear, result[:method]
      assert result[:model_notice].present?
      assert_equal BigDecimal("1066.67"), result[:projected_balance]
    end
  end

  test "chronos skips requests when fewer than three calendar days are available" do
    transaction("100", Date.current - 1)

    without_chronos do
      result = Finance::CashFlowForecast.new(user: @user, engine: "chronos").to_h
      assert_equal :chronos, result[:requested_engine]
      assert_equal :linear, result[:method]
      assert result[:model_notice].present?
    end
  end

  test "chronos explains that all stale history was not sent and the average falls back to the latest available data" do
    transaction("100", Date.current - 100)
    transaction("-50", Date.current - 99)

    without_chronos do
      result = Finance::CashFlowForecast.new(user: @user, engine: "chronos", days: 30).to_h

      assert_equal :chronos, result[:requested_engine]
      assert_equal :linear, result[:method]
      assert result[:has_history]
      assert_equal 2, result[:history_days]
      assert_equal BigDecimal(50), result[:daily_income]
      assert_equal BigDecimal(25), result[:daily_expenses]
      assert_equal 31, result[:points].length
      assert_equal BigDecimal(1750), result[:projected_balance]
      assert_match(/not run/i, result[:model_notice])
      assert_match(/90 days/i, result[:model_notice])
      assert_match(/recent statements/i, result[:model_notice])
    end
  end

  test "chronos skips requests when starting cash is unavailable" do
    transaction("100", Date.current - 2)
    @profile.update!(current_balance: 0, balance_source: nil)

    without_chronos do
      result = Finance::CashFlowForecast.new(user: @user, engine: "chronos").to_h
      assert_equal :chronos, result[:requested_engine]
      assert_equal :linear, result[:method]
      refute result[:balance_available]
      assert_empty result[:points]
      assert result[:model_notice].present?
    end
  end

  test "eligible explicit prophet uses its projector without contacting chronos" do
    add_prophet_history
    rows = Array.new(Finance::ProphetProjector::MAX_HORIZON) do |offset|
      Finance::ProphetProjector::Day.new(date: Date.current + offset + 1,
        income: 20, income_lower: 10, income_upper: 30,
        expenses: 5, expenses_lower: 2, expenses_upper: 8)
    end
    projector = Object.new
    projector.define_singleton_method(:call) { rows }

    without_chronos do
      stub_method(Finance::ProphetProjector, :new, ->(**) { projector }) do
        result = Finance::CashFlowForecast.new(user: @user, engine: "prophet", days: 2).to_h
        assert_equal :prophet, result[:requested_engine]
        assert_equal :prophet, result[:method]
        assert_equal BigDecimal(1030), result[:projected_balance]
        assert result[:points].last.key?(:lower)
      end
    end
  end

  test "short explicit prophet history has a visible linear fallback" do
    transaction("100", Date.current - 2)

    without_chronos do
      result = Finance::CashFlowForecast.new(user: @user, engine: "prophet").to_h
      assert_equal :prophet, result[:requested_engine]
      assert_equal :linear, result[:method]
      assert result[:model_notice].present?
    end
  end

  test "server default selects a valid engine and invalid server defaults use prophet" do
    transaction("100", Date.current - 2)
    ENV["FORECAST_ENGINE"] = "linear"
    assert_equal :linear, Finance::CashFlowForecast.new(user: @user).to_h[:requested_engine]

    ENV["FORECAST_ENGINE"] = "unknown"
    result = Finance::CashFlowForecast.new(user: @user).to_h
    assert_equal :prophet, result[:requested_engine]
    assert_equal :linear, result[:method]
  end

  test "unsupported explicit engine is a scenario validation error" do
    assert_raises(Finance::CashFlowForecast::InvalidScenario) do
      Finance::CashFlowForecast.new(user: @user, engine: "unknown")
    end
  end

  private

  def statement_for(user, digest)
    Finance::Statement.create!(user: user, filename: "#{digest}.csv", currency: "USD", sha256: digest * 64, transaction_count: 1)
  end

  def transaction(amount, date, category: "Income", excluded: false)
    Finance::Transaction.create!(user: @user, statement: @statement, booked_on: date,
      description: "Forecast test", amount: amount, category: category, excluded: excluded)
  end

  def add_prophet_history
    10.times { |offset| transaction("-10", Date.current - 59 + offset, category: "Food & dining") }
  end

  def with_chronos(handler)
    client = Object.new
    client.define_singleton_method(:call) { |**arguments| handler.call(**arguments) }
    stub_method(Finance::BillieForecastClient, :new, -> { client }) { yield }
  end

  def without_chronos(&block)
    stub_method(Finance::BillieForecastClient, :new, ->(*) { flunk "This forecast must not contact Chronos" }, &block)
  end

  def chronos_response
    {
      "provider" => "chronos", "model" => "amazon/chronos-2", "currency" => "USD",
      "balance_as_of" => Date.current.iso8601, "starting_balance" => "1000.00",
      "projected_balance" => "1030.00", "history_days" => 3, "days" => 2,
      "income_adjustment" => "100.0", "expense_adjustment" => "100.0",
      "points" => (1..2).map do |offset|
        {"date" => (Date.current + offset).iso8601, "income" => "20.00", "expenses" => "5.00",
         "net_flow" => "15.00", "balance" => (1000 + 15 * offset).to_s}
      end,
      "warnings" => [], "assumptions" => []
    }
  end
end
