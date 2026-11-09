require "test_helper"
require_relative "../../support/xlsx_reader"

class Finance::ExcelReportTest < ActiveSupport::TestCase
  setup do
    @user = create(:user)
    @profile = Finance::Profile.create!(user: @user, currency: "USD", cash_on_hand: "40.00")
    @account = Finance::BankAccount.create!(user: @user, identity_key: "c" * 64, bank_name: "Chase", name: "Checking", last4: "1111", kind: "cash")
    @statement = Finance::Statement.create!(user: @user, bank_account: @account, filename: "jan.csv", currency: "USD", sha256: "1" * 64,
      transaction_count: 5, closing_balance: "1500.25", closing_balance_on: Date.new(2026, 1, 31), balance_observed_on: Date.new(2026, 1, 31))
    add(Date.new(2026, 1, 2), "Payroll ACME", "3000.00", "Income")
    add(Date.new(2026, 1, 5), "Whole Foods Market", "-120.50", "Food & dining")
    add(Date.new(2026, 1, 9), "Landlord rent", "-1000.00", "Housing")
    add(Date.new(2026, 1, 10), "Transfer to savings", "-500.00", "Transfers")
    add(Date.new(2026, 1, 12), "Ignored refund", "-9.99", "Shopping", excluded: true)
    Finance::BalanceSync.call(user: @user)
    @profile.reload
  end

  def add(date, description, amount, category, **attributes)
    Finance::Transaction.create!(user: @user, statement: @statement, booked_on: date, description: description, amount: amount, category: category, **attributes)
  end

  def build(sheets: Finance::Report::SHEETS, period: Finance::DashboardPeriod.new(preset: "all_time"), user: @user, profile: @profile)
    report = Finance::Report.new(user: user, profile: profile, period: period)
    XlsxReader.new(Finance::ExcelReport.new(report, sheets: sheets).to_xlsx)
  end

  test "workbook has the four worksheets and overview totals match the dashboard snapshot" do
    book = build
    assert_equal %w[Overview Accounts Categories Transactions], book.sheet_names
    snapshot = Finance::Snapshot.new(user: @user).to_h
    assert_in_delta snapshot[:income].to_f, book.lookup("Overview", "Total income"), 0.001
    assert_in_delta snapshot[:expenses].to_f, book.lookup("Overview", "Total expenses"), 0.001
    assert_in_delta snapshot[:net].to_f, book.lookup("Overview", "Net cash flow"), 0.001
    assert_in_delta 3000.0, book.lookup("Overview", "Total income"), 0.001
    assert_in_delta 1120.5, book.lookup("Overview", "Total expenses"), 0.001
    assert_in_delta 1500.25, book.lookup("Overview", "Available cash balance"), 0.001
    assert_in_delta 40.0, book.lookup("Overview", "Cash on hand"), 0.001
    assert_equal 5.0, book.lookup("Overview", "Transactions")
    assert_kind_of Float, book.lookup("Overview", "Total income"), "money must stay numeric"
    assert_empty book.formulas
  end

  test "accounts sheet lists balances and the cash total" do
    rows = build.rows("Accounts")
    assert_equal ["Account", "Bank", "Type", "Last 4", "Balance", "Amount owed", "As of", "Status"], rows.first
    chase = rows.find { |row| row[0] == @account.display_name }
    assert_equal "Chase", chase[1]
    assert_equal "1111", chase[3]
    assert_in_delta 1500.25, chase[4], 0.001
    assert_equal "Balance known", chase[7]
    total = rows.find { |row| row[0] == "Total cash" }
    assert_in_delta 1540.25, total[4], 0.001
  end

  test "categories sheet shows amounts and shares of expenses" do
    rows = build.rows("Categories")
    assert_equal ["Category", "Amount", "Share of expenses"], rows.first
    housing = rows.find { |row| row[0] == "Housing" }
    assert_in_delta 1000.0, housing[1], 0.001
    assert_in_delta 1000.0 / 1120.5, housing[2], 0.0001
    refute rows.any? { |row| row[0] == "Transfers" }, "transfers are not spending"
    refute rows.any? { |row| row[0] == "Shopping" }, "excluded rows are not spending"
  end

  test "transactions sheet keeps corrected categories and marks rows left out of totals" do
    corrected = @user.finance_transactions.find_by!(description: "Whole Foods Market")
    corrected.update!(category: "Business")
    rows = build.rows("Transactions")
    assert_equal ["Date", "Account", "Merchant", "Description", "Category", "Amount", "Currency", "Tax review", "Excluded", "Counted in totals"], rows.first
    assert_equal 6, rows.size
    whole_foods = rows.find { |row| row[3] == "Whole Foods Market" }
    assert_equal "Business", whole_foods[4]
    assert_equal @account.display_name, whole_foods[1]
    assert_equal "Whole Foods", whole_foods[2], "merchant is the same two-word name used for remembered categories"
    assert_in_delta(-120.5, whole_foods[5], 0.001)
    assert_equal "No", rows.find { |row| row[3] == "Transfer to savings" }[9]
    assert_equal "Yes", rows.find { |row| row[3] == "Ignored refund" }[8]
  end

  test "spreadsheet formulas in imported text are stored as plain text" do
    add(Date.new(2026, 1, 15), "=HYPERLINK(\"http://evil.example\",\"click\")", "-1.00", "Uncategorized")
    add(Date.new(2026, 1, 16), "@SUM(A1:A9)", "-1.00", "Uncategorized")
    @account.update!(custom_name: "+cmd|' /C calc'!A0")
    book = build
    assert_empty book.formulas
    descriptions = book.rows("Transactions").map { |row| row[3] }
    assert_includes descriptions, "=HYPERLINK(\"http://evil.example\",\"click\")"
    assert_includes descriptions, "@SUM(A1:A9)"
    assert book.rows("Accounts").any? { |row| row[0] == "+cmd|' /C calc'!A0" }
  end

  test "a person with no data still gets a complete, readable workbook" do
    empty_user = create(:user)
    profile = Finance::Profile.create!(user: empty_user, currency: "EUR")
    book = build(user: empty_user, profile: profile)
    assert_equal 4, book.sheet_names.size
    assert_equal 0.0, book.lookup("Overview", "Total income")
    assert_equal "Not available", book.lookup("Overview", "Available cash balance")
    assert book.rows("Transactions").any? { |row| row[0] == "No transactions in this period." }
    assert book.rows("Categories").any? { |row| row[0] == "No expenses in this period." }
    assert book.rows("Accounts").any? { |row| row[0] == "No accounts have been identified from your statements yet." }
  end

  test "only chosen worksheets are included, in the standard order" do
    assert_equal %w[Categories Transactions], build(sheets: %w[transactions categories bogus]).sheet_names
    assert_raises(ArgumentError) { build(sheets: %w[bogus]) }
  end

  test "a period limits totals and transactions to those dates" do
    period = Finance::DashboardPeriod.new(preset: "custom", start_date: "2026-01-05", end_date: "2026-01-09")
    book = build(period: period)
    assert_equal 0.0, book.lookup("Overview", "Total income")
    assert_in_delta 1120.5, book.lookup("Overview", "Total expenses"), 0.001
    assert_equal 3, book.rows("Transactions").size
  end

  test "another person's records never appear and a mismatched profile is refused" do
    other = create(:user)
    other_statement = Finance::Statement.create!(user: other, filename: "secret.csv", currency: "USD", sha256: "9" * 64, transaction_count: 1)
    Finance::Transaction.create!(user: other, statement: other_statement, booked_on: Date.new(2026, 1, 3), description: "Other person salary", amount: "99999", category: "Income")
    book = build
    refute book.rows("Transactions").flatten.include?("Other person salary")
    assert_in_delta 3000.0, book.lookup("Overview", "Total income"), 0.001
    assert_raises(ArgumentError) { Finance::Report.new(user: other, profile: @profile, period: Finance::DashboardPeriod.new) }
  end
end
