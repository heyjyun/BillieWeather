require "test_helper"
require "csv"

class FinanceDashboardPeriodTest < ActionDispatch::IntegrationTest
  include Devise::Test::IntegrationHelpers

  setup do
    @user = create(:user, time_zone: "Central Time (US & Canada)")
    @profile = Finance::Profile.create!(user: @user, current_balance: "2500.00")
    @statement = Finance::Statement.create!(user: @user, filename: "dashboard.csv", currency: "USD",
      sha256: "a" * 64, transaction_count: 9)

    transaction("2024-12-31", "Previous year deposit", "500.00", "Income")
    transaction("2025-01-01", "Last year purchase", "-25.00", "Shopping")
    transaction("2026-09-30", "September housing", "-80.00", "Housing")
    transaction("2026-10-01", "October salary", "1000.00", "Income")
    transaction("2026-10-15", "October groceries", "-120.00", "Food & dining")
    transaction("2026-10-25", "October account transfer", "-700.00", "Transfers")
    transaction("2026-10-26", "October excluded purchase", "-900.00", "Shopping", excluded: true)
    transaction("2026-10-31", "October utilities", "-30.00", "Utilities")
    transaction("2026-11-01", "November salary", "3000.00", "Income")

    other_user = create(:user)
    other_statement = Finance::Statement.create!(user: other_user, filename: "private.csv", currency: "USD",
      sha256: "b" * 64, transaction_count: 1)
    Finance::Transaction.create!(user: other_user, statement: other_statement, booked_on: "2026-10-15",
      description: "Private other-account payroll", amount: "99999.00", category: "Income")
    sign_in @user
  end

  def section(name, **scope)
    get finance_dashboard_path(format: :json), params: scope.merge(section: name)
    assert_response :success
    assert_includes response.headers.fetch("Cache-Control"), "no-store"
    JSON.parse(response.body)
  end

  test "default layout opens directly and only exposes the authenticated ledger" do
    get finance_dashboard_path
    assert_response :success
    assert_select "#transactions-tabs", count: 0
    assert_select "#financial-overview"
    assert_select "h1", text: "Financial Overview"
    days = section("flow")
    assert_equal 450_000, days.sum { |d| d["income"] }
    assert_equal 25_500, days.sum { |d| d["expenses"] }
    assert_equal 250_000, section("position")["cashOverride"]
    refute_includes section("recent").to_s, "Private other-account payroll"
    assert_equal 4, section("spending").length
  end

  test "a bookmarkable range filters recent transactions and spending and keeps the previous period for comparison" do
    dates = {preset: "custom", start_date: "2026-10-01", end_date: "2026-10-31"}
    before_records = @user.finance_transactions.order(:id).map(&:attributes)
    get finance_dashboard_path, params: dates
    ctx = JSON.parse(css_select("#financial-overview").first["data-context"])
    assert_equal dates[:start_date], ctx.dig("initial", "period", "startDate")
    assert_equal dates[:end_date], ctx.dig("initial", "period", "endDate")
    days = section("flow", **dates)
    assert_equal "2026-09-30", days.first["date"]
    october = days.select { |d| d["date"].start_with?("2026-10") }
    assert_equal 100_000, october.sum { |d| d["income"] }
    assert_equal 15_000, october.sum { |d| d["expenses"] }
    names = section("recent", **dates).pluck("name")
    assert_equal 5, names.size
    assert_includes names, "October account transfer"
    assert_includes names, "October excluded purchase"
    assert_equal [3000, 12000], section("spending", **dates).pluck("amount").sort
    get finance_transactions_path(format: :csv), params: dates
    assert_equal names.sort, CSV.parse(response.body, headers: true).map { |r| r["Description"] }.sort
    assert_equal before_records, @user.finance_transactions.order(:id).map(&:attributes)
  end

  test "empty, invalid and transfer only periods remain distinguishable" do
    assert_empty section("recent", preset: "custom", start_date: "2025-03-01", end_date: "2025-03-31")
    day = section("flow", preset: "custom", start_date: "2026-10-25", end_date: "2026-10-25").last
    assert_equal({"date" => "2026-10-25", "income" => 0, "expenses" => 0, "counted" => false}, day)
    [["2026-02-30", "2026-03-31"], ["2026-10-31", "2026-10-01"], ["2026-10-01", ""], ["1899-12-31", "2026-10-31"]].each do |from, to|
      get finance_dashboard_path, params: {preset: "custom", start_date: from, end_date: to}
      assert_response :unprocessable_entity
      assert_select "[role=alert]"
      assert_select "#financial-overview", count: 0
    end
  end

  test "projection, saved insight and budget stay unavailable without supporting records" do
    travel_to Time.zone.local(2030, 1, 1) do
      assert_empty section("forecast")
      assert_nil section("insight")
      assert_nil section("budget")
      Finance::Budget.create!(user: @user, period: "month", amount: 200)
      assert_equal 20_000, section("budget")
      Finance::Insight.create!(user: @user, kind: "general", source: "openai", generated_at: Time.current, content: {"summary" => "Synthetic saved summary"})
      assert_equal "Synthetic saved summary", section("insight")["text"]
      assert_nil section("insight", preset: "this_month")
    end
  end

  test "invalid transaction date filters cannot display or export an unfiltered list" do
    get finance_dashboard_path
    dates = {start_date: "not-a-date", end_date: "2026-10-31"}
    get finance_transactions_path, params: dates
    assert_response :unprocessable_entity
    assert_select "[role='alert']"
    assert_select "table tbody tr", count: 0
    assert_not_includes response.body, "November salary"
    get finance_transactions_path(format: :csv), params: dates
    assert_response :unprocessable_entity
    assert_includes response.body, "valid dates"
    assert_not_includes response.body, "October salary"
  end

  test "account and date scope control all figures and drill-down without counting a card payment" do
    checking = Finance::BankAccount.create!(user: @user, manual: true, name: "Synthetic checking", account_type: "checking", currency: "USD")
    card = Finance::BankAccount.create!(user: @user, manual: true, name: "Synthetic card", account_type: "credit_card", currency: "USD")
    ledger = Finance::Ledger.new(@user)
    ledger.create(kind: "income", account_id: checking.id, booked_on: "2026-10-05", amount: "1000", category: "Income", description: "Scoped salary")
    purchase = ledger.create(kind: "expense", account_id: card.id, booked_on: "2026-10-06", amount: "80", category: "Shopping", description: "Scoped purchase")
    ledger.create(kind: "refund", account_id: card.id, booked_on: "2026-10-07", amount: "30", refund_of_id: purchase.id)
    ledger.create(kind: "transfer", account_id: checking.id, to_account_id: card.id, booked_on: "2026-10-08", amount: "50")
    dates = {preset: "custom", start_date: "2026-10-01", end_date: "2026-10-31"}

    days = section("flow", **dates, account_id: card.id)
    assert_equal 5000, days.sum { |d| d["expenses"] }
    assert_equal 0, days.sum { |d| d["income"] }
    assert_equal 100_000, section("flow", **dates, account_id: checking.id).sum { |d| d["income"] }
    euro = Finance::BankAccount.create!(user: @user, manual: true, name: "Euro wallet", account_type: "cash", currency: "EUR", opening_balance: 10)
    ledger.create(kind: "expense", account_id: euro.id, booked_on: "2026-10-06", amount: "3", category: "Shopping", description: "Euro fare")
    assert_equal 300, section("flow", **dates, currency: "EUR").sum { |d| d["expenses"] }
    assert_equal 700, section("position", currency: "EUR")["holdings"].first["balance"]
    get finance_transactions_path, params: dates.merge(currency: "EUR", category: "Shopping")
    assert_select "table tbody tr", count: 1
    assert_select "table strong", text: "Euro fare"
    assert_select "a[href*='transactions.csv'][href*='currency=EUR']"
    get finance_transactions_path(format: :csv), params: dates.merge(currency: "USD", account_id: card.id, activity: "spending")
    csv = CSV.parse(response.body, headers: true)
    assert_equal 2, csv.length
    assert_equal ["-80.0", "30.0"], csv.map { |row| row["Amount"] }.sort
  end

  test "invalid account scopes never expose a broader overview" do
    get finance_dashboard_path
    owner = create(:user)
    foreign = Finance::BankAccount.create!(user: owner, manual: true, name: "Private", account_type: "cash", currency: "USD")
    [foreign.id, "missing", ["untrusted"]].each do |id|
      get finance_dashboard_path, params: {account_id: id}
      assert_response :unprocessable_entity
      assert_select "#dashboard-income", count: 0
      assert_select "#dashboard-period-error", text: "Choose an account from this ledger."
    end
  end

  private

  def transaction(booked_on, description, amount, category, excluded: false)
    Finance::Transaction.create!(user: @user, statement: @statement, booked_on: booked_on,
      description: description, amount: amount, category: category, excluded: excluded)
  end
end
