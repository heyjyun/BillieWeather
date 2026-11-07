require "test_helper"
require_relative "../support/billie_method_stub"

class FinanceForecastEnginesTest < ActionDispatch::IntegrationTest
  include Devise::Test::IntegrationHelpers
  include BillieMethodStub

  setup do
    travel_to Time.zone.local(2026, 11, 6, 12)
    @previous_engine = ENV["FORECAST_ENGINE"]
    ENV.delete("FORECAST_ENGINE")
    @user = create(:user)
    @profile = Finance::Profile.create!(user: @user, current_balance: "1000", balance_source: "manual")
    @statement = Finance::Statement.create!(user: @user, filename: "forecast.csv", currency: "USD", sha256: "e" * 64, transaction_count: 1)
    Finance::Transaction.create!(user: @user, statement: @statement, booked_on: Date.current - 2,
      description: "Forecast income", amount: 90, category: "Income")
    sign_in @user
  end

  teardown do
    @previous_engine.nil? ? ENV.delete("FORECAST_ENGINE") : ENV["FORECAST_ENGINE"] = @previous_engine
    travel_back
  end

  test "linear can be selected and forecast GET leaves stored financial records unchanged" do
    before = financial_records

    stub_method(Finance::ProphetProjector, :eligible?, ->(*) { flunk "Linear should bypass Prophet" }) do
      stub_method(Finance::BillieForecastClient, :new, ->(*) { flunk "Linear should bypass Chronos" }) do
        get finance_forecast_path, params: {engine: "linear", days: 30}
      end
    end

    assert_response :success
    assert_select "select#engine option[value='linear'][selected]"
    assert_select "#forecast-model", text: /linear|average|straight/i
    assert_select "#forecast-model-notice", count: 0
    assert_equal before, financial_records
    assert_includes response.headers["Cache-Control"], "no-store"
  end

  test "successful chronos response shows selected and actual model" do
    before = financial_records

    with_chronos(->(**) { chronos_response }) do
      get finance_forecast_path, params: {engine: "chronos", days: 2}
    end

    assert_response :success
    assert_select "select#engine option[value='chronos'][selected]"
    assert_select "#forecast-model", text: /Chronos/i
    assert_select "#forecast-projected-balance strong", text: "$1,030.00"
    assert_equal before, financial_records
  end

  test "chronos connection failure retains selection and displays actual fallback" do
    with_chronos(->(**) { raise Finance::BillieForecastClient::Unavailable, "Forecast service unavailable" }) do
      get finance_forecast_path, params: {engine: "chronos", days: 30}
    end

    assert_response :success
    assert_select "select#engine option[value='chronos'][selected]"
    assert_select "#forecast-model", text: /linear|average|straight/i
    assert_select "#forecast-model-notice", text: /\S/
    assert_select "#forecast-projected-balance strong", text: "$1,900.00"
  end

  test "prophet short-history fallback remains visible with prophet selected" do
    get finance_forecast_path, params: {engine: "prophet"}

    assert_response :success
    assert_select "select#engine option[value='prophet'][selected]"
    assert_select "#forecast-model", text: /linear|average|straight/i
    assert_select "#forecast-model-notice", text: /\S/
  end

  test "unsupported engine is rejected without contacting the python service" do
    stub_method(Finance::BillieForecastClient, :new, ->(*) { flunk "Invalid engine must not contact Chronos" }) do
      get finance_forecast_path, params: {engine: "unrecognized-model"}
    end

    assert_response :unprocessable_entity
    assert_select "[role='alert']", text: /engine|model|forecast/i
  end

  private

  def financial_records
    [Finance::Profile, Finance::Statement, Finance::Transaction].map do |model|
      model.where(user_id: @user.id).order(:id).map(&:attributes)
    end
  end

  def with_chronos(handler)
    client = Object.new
    client.define_singleton_method(:call) { |**arguments| handler.call(**arguments) }
    stub_method(Finance::BillieForecastClient, :new, -> { client }) { yield }
  end

  def chronos_response
    {
      "provider" => "chronos", "model" => "amazon/chronos-2", "currency" => "USD",
      "balance_as_of" => Date.current.iso8601, "starting_balance" => "1000.00",
      "projected_balance" => "1030.00", "history_days" => 3, "days" => 2,
      "income_adjustment" => "0.0", "expense_adjustment" => "0.0",
      "points" => (1..2).map do |offset|
        {"date" => (Date.current + offset).iso8601, "income" => "20.00", "expenses" => "5.00",
         "net_flow" => "15.00", "balance" => (1000 + 15 * offset).to_s}
      end,
      "warnings" => [], "assumptions" => []
    }
  end
end
