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

  test "dashboard defaults to all imported dates and preserves the saved current balance" do
    get finance_dashboard_path

    assert_response :success
    assert_metric "income", "$4,500.00"
    assert_metric "expenses", "$255.00"
    assert_metric "net", "$4,245.00"
    assert_metric "balance", "$2,500.00"
    assert_select ".bw-page-heading p", text: /Dec 31, 2024.*Nov 1, 2026/
    assert_not_includes response.body, "Private other-account payroll"
  end

  test "a bookmarkable custom range filters all dashboard figures and transactions inclusively without changing records" do
    before_records = Finance::Transaction.order(:id).map(&:attributes)
    url = finance_dashboard_path(preset: "custom", start_date: "2026-10-01", end_date: "2026-10-31")

    get url

    assert_response :success
    assert_metric "income", "$1,000.00"
    assert_metric "expenses", "$150.00"
    assert_metric "net", "$850.00"
    assert_metric "balance", "$2,500.00"
    assert_date_fields "2026-10-01", "2026-10-31"
    assert_select ".bw-page-heading p", text: /Oct 1, 2026.*Oct 31, 2026/
    assert_select ".bw-chart-details p", text: /Oct 2026: income \$1,000\.00.*expenses \$150\.00/
    assert_select ".bw-chart-details p", count: 1
    assert_select ".bw-category-row", text: /Food & dining.*\$120\.00/
    assert_select ".bw-category-row", text: /Utilities.*\$30\.00/
    assert_select ".bw-category-row", text: /Shopping|Housing|Transfers/, count: 0
    assert_select "table tbody tr", count: 5
    ["October salary", "October groceries", "October utilities", "October account transfer", "October excluded purchase"].each do |description|
      assert_select "table strong", text: description
    end
    ["Previous year deposit", "Last year purchase", "September housing", "November salary", "Private other-account payroll"].each do |description|
      assert_not_includes response.body, description
    end

    view_all_url = nil
    assert_select "a", text: /\AView all/ do |links|
      view_all_url = links.first["href"]
    end
    assert_match(/start_date=2026-10-01/, view_all_url)
    assert_match(/end_date=2026-10-31/, view_all_url)
    get view_all_url
    assert_response :success
    assert_select "table tbody tr", count: 5
    assert_not_includes response.body, "November salary"
    assert_not_includes response.body, "Private other-account payroll"

    export_url = nil
    assert_select "a", text: "Export CSV" do |links|
      export_url = links.first["href"]
    end
    get export_url
    assert_response :success
    exported_rows = CSV.parse(response.body, headers: true)
    assert_equal ["October account transfer", "October excluded purchase", "October groceries", "October salary", "October utilities"],
      exported_rows.map { |row| row["Description"] }.sort
    assert exported_rows.all? { |row| row["Date"].between?("2026-10-01", "2026-10-31") }
    assert_equal before_records, Finance::Transaction.order(:id).map(&:attributes)
    assert_equal BigDecimal("2500.00"), @profile.reload.current_balance
  end

  test "the heading shows the requested period even when transactions cover fewer days" do
    get finance_dashboard_path, params: {preset: "custom", start_date: "2026-09-01", end_date: "2026-09-30"}

    assert_response :success
    assert_date_fields "2026-09-01", "2026-09-30"
    assert_select ".bw-page-heading p", text: /Sep 1, 2026.*Sep 30, 2026/
    assert_metric "expenses", "$80.00"
    assert_select "table tbody tr", count: 1
    assert_select "table strong", text: "September housing"
  end

  test "an empty selected period offers a reset without showing first-upload onboarding" do
    get finance_dashboard_path, params: {preset: "custom", start_date: "2025-03-01", end_date: "2025-03-31"}

    assert_response :success
    assert_date_fields "2025-03-01", "2025-03-31"
    assert_select ".bw-page-heading p", text: /Mar 1, 2025.*Mar 31, 2025/
    assert_metric "income", "$0.00"
    assert_metric "expenses", "$0.00"
    assert_metric "balance", "$2,500.00"
    assert_select "table tbody tr", count: 0
    assert_match(/No transactions in this period/i, response.body)
    assert_select "a", text: /all (?:imported )?(?:dates|transactions)|reset|clear (?:date )?filter/i
    assert_not_includes response.body, "Upload your first statement"
  end

  test "invalid incomplete reversed and out-of-bounds custom dates fail visibly and retain their fields" do
    # Establish the signed-in session before the first non-successful request.
    get finance_dashboard_path
    assert_response :success

    [
      {start_date: "2026-02-30", end_date: "2026-03-31"},
      {start_date: "2026-10-31", end_date: "2026-10-01"},
      {start_date: "2026-10-01", end_date: ""},
      {start_date: "1899-12-31", end_date: "2026-10-31"}
    ].each do |dates|
      get finance_dashboard_path, params: dates.merge(preset: "custom")

      assert_response :unprocessable_entity
      assert_select "[role='alert']", minimum: 1
      assert_date_fields dates[:start_date], dates[:end_date]
      assert_select "table tbody tr", count: 0
      assert_not_includes response.body, "November salary"
    end
  end

  test "last month resolves to the entire previous calendar month" do
    travel_to Time.find_zone!("Central Time (US & Canada)").local(2026, 11, 15, 12, 0, 0) do
      get finance_dashboard_path, params: {preset: "last_month"}

      assert_response :success
      assert_date_fields "2026-10-01", "2026-10-31"
      assert_select ".bw-page-heading p", text: /Oct 1, 2026.*Oct 31, 2026/
      assert_metric "income", "$1,000.00"
      assert_metric "expenses", "$150.00"
      assert_metric "balance", "$2,500.00"
      assert_select "table tbody tr", count: 5
      assert_not_includes response.body, "November salary"
    end
  end

  test "a transfer-only period retains its transactions while totals stay zero" do
    get finance_dashboard_path, params: {preset: "custom", start_date: "2026-10-25", end_date: "2026-10-25"}
    assert_response :success
    assert_metric "income", "$0.00"
    assert_metric "expenses", "$0.00"
    assert_select "table tbody tr", count: 1
    assert_select "table strong", text: "October account transfer"
    assert_select "#dashboard-period-empty", count: 0
    assert_not_includes response.body, "Upload your first statement"
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

  test "last year resolves to the previous calendar year rather than a rolling year" do
    travel_to Time.find_zone!("Central Time (US & Canada)").local(2026, 11, 15, 12, 0, 0) do
      get finance_dashboard_path, params: {preset: "last_year"}

      assert_response :success
      assert_date_fields "2025-01-01", "2025-12-31"
      assert_select ".bw-page-heading p", text: /Jan 1, 2025.*Dec 31, 2025/
      assert_metric "income", "$0.00"
      assert_metric "expenses", "$25.00"
      assert_metric "balance", "$2,500.00"
      assert_select "table tbody tr", count: 1
      assert_select "table strong", text: "Last year purchase"
      assert_not_includes response.body, "Previous year deposit"
      assert_not_includes response.body, "October salary"
    end
  end

  private

  def transaction(booked_on, description, amount, category, excluded: false)
    Finance::Transaction.create!(user: @user, statement: @statement, booked_on: booked_on,
      description: description, amount: amount, category: category, excluded: excluded)
  end

  def assert_metric(name, amount)
    assert_select "#dashboard-#{name} strong", text: amount
  end

  def assert_date_fields(start_date, end_date)
    assert_select "input#start_date", count: 1 do |inputs|
      assert_equal start_date, inputs.first["value"].to_s
    end
    assert_select "input#end_date", count: 1 do |inputs|
      assert_equal end_date, inputs.first["value"].to_s
    end
  end
end
