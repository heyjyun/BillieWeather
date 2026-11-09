require "test_helper"
require "csv"
require_relative "../support/xlsx_reader"

class FinanceReportExportTest < ActionDispatch::IntegrationTest
  include Devise::Test::IntegrationHelpers

  setup do
    @user = create(:user)
    @statement = Finance::Statement.create!(user: @user, filename: "jan.csv", currency: "USD", sha256: "2" * 64, transaction_count: 3)
    @salary = add(Date.current, "Payroll", "2500.00", "Income")
    @coffee = add(Date.current, "ZXQ Beans, \"Downtown\"", "-12.40", "Uncategorized")
    @rent = add(Date.current - 400, "Old rent", "-900.00", "Housing")
  end

  def add(date, description, amount, category)
    Finance::Transaction.create!(user: @user, statement: @statement, booked_on: date, description: description, amount: amount, category: category)
  end

  def csv_rows(body)
    CSV.parse(body.dup.force_encoding("UTF-8").delete_prefix("﻿"), headers: true)
  end

  test "dashboard offers Export report for the period on screen" do
    sign_in @user
    get finance_dashboard_path(preset: "this_month")
    assert_response :success
    assert_select "a#dashboard-export-report[href*='preset=this_month']", text: /Export report/
    get finance_dashboard_path
    assert_select "a#dashboard-export-report[href*='preset=all_time']"
  end

  test "export page defaults to Excel with every worksheet selected" do
    sign_in @user
    get finance_report_path(preset: "this_year")
    assert_response :success
    assert_select "input[type=radio][name=export_format][value=xlsx][checked]"
    assert_select "input[type=radio][name=export_format][value=csv]:not([checked])"
    Finance::Report::SHEETS.each { |sheet| assert_select "input[type=checkbox][name='sheets[]'][value=#{sheet}][checked]" }
    assert_select "form[action='#{download_finance_report_path}'] input[type=hidden][name=preset][value=this_year]"
  end

  test "Excel download uses real data, matches the dashboard and keeps corrected categories" do
    sign_in @user
    patch finance_transaction_path(@coffee), params: {finance_transaction: {category: "Food & dining"}}
    assert_redirected_to finance_transactions_path

    get download_finance_report_path(preset: "this_month", export_format: "xlsx", sheets: ["", *Finance::Report::SHEETS])
    assert_response :success
    assert_equal ReportsControllerTypes::XLSX, response.media_type
    assert_match(/attachment; filename="billieweather-report-\d{4}-\d{2}-\d{2}-to-\d{4}-\d{2}-\d{2}-\d{4}-\d{2}-\d{2}\.xlsx"/, response.headers["Content-Disposition"])
    assert_includes response.headers["Cache-Control"], "no-store"

    book = XlsxReader.new(response.body)
    period = Finance::DashboardPeriod.new(preset: "this_month", today: Date.current)
    snapshot = Finance::Snapshot.new(user: @user, start_date: period.start_date, end_date: period.end_date).to_h
    assert_in_delta snapshot[:income].to_f, book.lookup("Overview", "Total income"), 0.001
    assert_in_delta 12.40, book.lookup("Overview", "Total expenses"), 0.001
    transactions = book.rows("Transactions")
    assert_equal 3, transactions.size, "header plus this month's two transactions"
    assert_equal "Food & dining", transactions.find { |row| row[3] == @coffee.description }[4]
    refute transactions.flatten.include?("Old rent")
    assert_equal "Food & dining", book.rows("Categories")[1][0]
  end

  test "dashboard figures shown on screen equal the exported ones" do
    sign_in @user
    get finance_dashboard_path
    income_on_screen = css_select("#dashboard-income strong").text.strip
    get download_finance_report_path(export_format: "xlsx")
    book = XlsxReader.new(response.body)
    assert_equal "$2,500.00", income_on_screen
    assert_in_delta 2500.0, book.lookup("Overview", "Total income"), 0.001
    assert_in_delta 912.40, book.lookup("Overview", "Total expenses"), 0.001
  end

  test "worksheet selection is honored and an empty selection is refused" do
    sign_in @user
    get download_finance_report_path(export_format: "xlsx", sheets: ["", "transactions"])
    assert_equal ["Transactions"], XlsxReader.new(response.body).sheet_names

    get download_finance_report_path(preset: "this_month", export_format: "xlsx", sheets: [""])
    assert_redirected_to finance_report_path(preset: "this_month")
    follow_redirect!
    assert_includes response.body, "Choose at least one worksheet"
  end

  test "CSV download has escaped, UTF-8, formula-safe rows with corrected categories" do
    add(Date.current, "=HYPERLINK(\"http://evil.example\")", "-1.00", "Uncategorized")
    add(Date.current, "東京 カフェ", "-3.00", "Uncategorized")
    sign_in @user
    patch finance_transaction_path(@coffee), params: {finance_transaction: {category: "Business"}}

    get download_finance_report_path(export_format: "csv")
    assert_response :success
    assert_equal "text/csv", response.media_type
    assert_match(/filename="billieweather-report-all-time-.*\.csv"/, response.headers["Content-Disposition"])
    assert response.body.b.start_with?("\xEF\xBB\xBF".b), "UTF-8 byte-order mark"
    rows = csv_rows(response.body)
    assert_equal Finance::TransactionCsv::HEADERS, rows.headers
    assert_equal 5, rows.size
    coffee = rows.find { |row| row["Description"] == "ZXQ Beans, \"Downtown\"" }
    assert_equal "Business", coffee["Category"]
    assert_equal "-12.4", coffee["Amount"]
    assert rows.any? { |row| row["Description"] == "'=HYPERLINK(\"http://evil.example\")" }
    assert rows.any? { |row| row["Description"] == "東京 カフェ" }
  end

  test "the Transactions page CSV keeps its original columns and uses the stronger formula escaping" do
    add(Date.current - 400, "  =cmd|' /C calc'!A0", "-2.00", "Housing")
    sign_in @user
    get finance_transactions_path(format: :csv, category: "Housing")
    assert_response :success
    refute response.body.start_with?("\uFEFF")
    rows = csv_rows(response.body)
    assert_equal ["Date", "Description", "Amount", "Currency", "Category", "Tax review", "Excluded"], rows.headers
    assert_equal ["  =cmd|' /C calc'!A0", "Old rent"].map { |text| Finance::TransactionCsv.safe_text(text) }.sort, rows.map { |row| row["Description"] }.sort
    assert rows.any? { |row| row["Description"].start_with?("'  =cmd") }
  end

  test "a report CSV statement without an identified account falls back to the file name" do
    sign_in @user
    get download_finance_report_path(export_format: "csv")
    assert_equal ["jan.csv"], csv_rows(response.body).map { |row| row["Account"] }.uniq
  end

  test "people with no data can still export both formats" do
    sign_in create(:user)
    get download_finance_report_path(export_format: "xlsx")
    assert_response :success
    assert_equal 0.0, XlsxReader.new(response.body).lookup("Overview", "Total income")
    get download_finance_report_path(export_format: "csv")
    assert_response :success
    assert_equal 0, csv_rows(response.body).size
  end

  test "exports never contain another person's data" do
    other = create(:user)
    statement = Finance::Statement.create!(user: other, filename: "other.csv", currency: "USD", sha256: "3" * 64, transaction_count: 1)
    Finance::Transaction.create!(user: other, statement: statement, booked_on: Date.current, description: "Someone else's bonus", amount: "777", category: "Income")
    sign_in @user
    get download_finance_report_path(export_format: "csv", user_id: other.id)
    refute_includes response.body, "Someone else"
    get download_finance_report_path(export_format: "xlsx", user_id: other.id)
    book = XlsxReader.new(response.body)
    refute book.rows("Transactions").flatten.include?("Someone else's bonus")
    assert_in_delta 2500.0, book.lookup("Overview", "Total income"), 0.001
  end

  test "signed-out visitors cannot export and bad input fails safely" do
    get download_finance_report_path(export_format: "csv")
    assert_redirected_to new_user_session_path
    get finance_report_path
    assert_redirected_to new_user_session_path

    sign_in @user
    get download_finance_report_path(export_format: "pdf")
    assert_redirected_to finance_report_path
    get download_finance_report_path(preset: "custom", start_date: "2026-13-40", end_date: "2026-01-01", export_format: "csv")
    assert_response :see_other
    get download_finance_report_path(export_format: ["csv"], sheets: {"a" => "b"})
    assert_response :see_other
    get finance_report_path(preset: "custom", start_date: "bad", end_date: "bad")
    assert_response :unprocessable_entity
    assert_select "[role=alert]"
  end

  test "the export page and workbook are fully translated" do
    sign_in @user
    get finance_report_path, params: {locale: "zh-CN"}
    assert_response :success
    assert_no_match(/translation_missing|Translation missing/, response.body)
    get download_finance_report_path(export_format: "xlsx")
    book = XlsxReader.new(response.body)
    assert_equal %w[概览 账户 类别 交易], book.sheet_names
    assert_in_delta 2500.0, book.lookup("概览", "总收入"), 0.001
  end

  module ReportsControllerTypes
    XLSX = Finance::ReportsController::XLSX_TYPE
  end
end
