require "test_helper"
require "csv"
require "tempfile"
require_relative "../support/finance_pdf_fixture"

class FinanceAccountBalancesTest < ActionDispatch::IntegrationTest
  include Devise::Test::IntegrationHelpers
  include FinancePdfFixture

  setup do
    @user = create(:user)
    sign_in @user
  end

  test "cash balances from two banks are added automatically and start the forecast" do
    import_statement(bank: "Chase", number: "1234561111", balance: "1000.00", name: "chase.csv")
    import_statement(bank: "Bank of America", number: "9876542222", kind: "Savings", balance: "2500.00", name: "boa.csv")

    assert_equal 2, Finance::BankAccount.where(user_id: @user.id).count
    assert_equal BigDecimal("3500.00"), @user.finance_profile.reload.current_balance
    get finance_dashboard_path
    assert_response :success
    assert_select "#dashboard-balance strong", text: "$3,500.00"

    get finance_forecast_path
    assert_response :success
    assert_select "#account-balances", text: /Chase/
    assert_select "#account-balances", text: /Bank of America/
    assert_select "#account-balances", text: /1,000\.00/
    assert_select "#account-balances", text: /2,500\.00/
    assert_not_includes response.body, "1234561111"
    assert_not_includes response.body, "9876542222"
    forecast = Finance::CashFlowForecast.new(user: @user).to_h
    assert_equal BigDecimal("3500.00"), forecast[:current_balance]
    assert_equal BigDecimal("3500.00"), forecast[:points].first[:balance]
  end

  test "each account contributes only its latest statement regardless of upload order" do
    import_statement(bank: "Chase", number: "1111", balance: "1000.00", date: "2026-10-31", name: "oct.csv")
    import_statement(bank: "Chase", number: "****1111", balance: "800.00", date: "2026-09-30", name: "sep.csv")
    import_statement(bank: "Chase", number: "1234561111", balance: "1200.00", date: "2026-11-05", name: "nov.csv")

    assert_equal 1, Finance::BankAccount.where(user_id: @user.id).count
    assert_equal BigDecimal("1200.00"), @user.finance_profile.reload.current_balance
    get finance_forecast_path
    assert_select "#account-balances", text: /1,200\.00/
    assert_select "#account-balances", text: /800\.00/, count: 0

    assert_no_difference ["Finance::BankAccount.count", "@user.finance_statements.count", "@user.finance_transactions.count"] do
      import_statement(bank: "Chase", number: "1234561111", balance: "1200.00", date: "2026-11-05", name: "renamed-nov.csv", success: false)
    end
    assert_response :unprocessable_entity
    assert_equal BigDecimal("1200.00"), @user.finance_profile.reload.current_balance
  end

  test "credit card balances never inflate cash available for forecasting" do
    import_statement(bank: "Chase", number: "1111", balance: "1000.00", name: "checking.csv")
    card = import_statement(bank: "Chase", number: "2222", kind: "Credit Card", balance: "500.00", name: "card.csv")

    assert_equal "credit", card.bank_account.kind
    assert_equal BigDecimal("1000.00"), @user.finance_profile.reload.current_balance
    assert_equal BigDecimal("1000.00"), Finance::CashFlowForecast.new(user: @user).to_h[:current_balance]
    get finance_forecast_path
    assert_response :success
    assert_select "#account-balances", text: /credit|card/i
  end

  test "an unidentified statement is shown for assignment instead of claiming zero cash" do
    statement = import_unidentified(balance: "123.45", name: "unidentified.csv")

    assert_nil statement.bank_account_id
    assert_nil @user.finance_profile.reload.balance_source
    get finance_dashboard_path
    assert_response :success
    assert_select "#dashboard-balance strong", text: /\$0\.00/, count: 0
    get finance_forecast_path
    assert_response :success
    assert_select "#unassigned-statements", text: /unidentified\.csv/
    assert_select "#forecast-starting-balance small", text: /Dated closing balances are saved for 1 statement, but their accounts are not identified/
    assert_select "#unassigned-statements a[href='#{finance_statements_path(anchor: "statement-#{statement.id}")}']"
    get finance_statements_path
    assert_select "#statement-#{statement.id} form[action='#{finance_statement_path(statement)}']"
    assert_equal 1, @user.finance_transactions.count
  end

  test "assigning statements to a new or existing account updates totals without rewriting transactions" do
    older = import_unidentified(balance: "300.00", name: "older.csv", date: "2026-10-31")
    newer = import_unidentified(balance: "450.00", name: "newer.csv", date: "2026-11-05")
    transactions_before = @user.finance_transactions.order(:id).map(&:attributes)

    assert_difference "Finance::BankAccount.where(user_id: @user.id).count", 1 do
      patch finance_statement_path(older), params: {bank_account: {
        bank_name: "Local Community Bank", name: "Everyday checking", last4: "4321", kind: "cash"
      }}
    end
    assert_response :redirect
    account = older.reload.bank_account
    assert_equal @user.id, account.user_id
    assert_equal BigDecimal("300.00"), @user.finance_profile.reload.current_balance

    assert_no_difference "Finance::BankAccount.count" do
      patch finance_statement_path(newer), params: {bank_account_id: account.id}
    end
    assert_response :redirect
    assert_equal account.id, newer.reload.bank_account_id
    assert_equal BigDecimal("450.00"), @user.finance_profile.reload.current_balance
    assert_equal transactions_before, @user.finance_transactions.order(:id).map(&:attributes)

    get finance_forecast_path
    assert_select "#account-balances", text: /Everyday checking|Local Community Bank/
    assert_select "#unassigned-statements", text: /older\.csv|newer\.csv/, count: 0
  end

  test "older imports with no saved balances explain both missing inputs and keep transactions" do
    first = import_unidentified(balance: nil, name: "older-one.csv", date: "2026-10-30")
    second = import_unidentified(balance: nil, name: "older-two.csv", date: "2026-10-31")
    transactions_before = @user.finance_transactions.order(:id).map(&:attributes)

    get finance_forecast_path
    assert_response :success
    assert_select "#forecast-starting-balance strong", text: "Not available"
    assert_select "#forecast-starting-balance small", text: /Transactions were imported from your 2 statements, but no account details or closing balances are saved/
    assert_select "#forecast-projected-balance strong", text: "Not available"
    assert_select ".bw-line-chart", count: 0

    get finance_statements_path
    [first, second].each do |statement|
      assert_select "#statement-#{statement.id}", text: /No closing balance saved/
    end
    assert_equal transactions_before, @user.finance_transactions.order(:id).map(&:attributes)

    patch finance_statement_path(first), params: {bank_account: {
      bank_name: "Chase", name: "Checking", last4: "1111", kind: "cash"
    }}
    assert_response :redirect
    get finance_forecast_path
    assert_select "#forecast-starting-balance strong", text: "Not available"
    assert_select "#forecast-starting-balance small", text: /latest statements.*no usable closing balances saved/
    assert_equal transactions_before, @user.finance_transactions.order(:id).map(&:attributes)
  end

  test "a credit-only account explains why its debt is not a cash balance" do
    import_statement(bank: "Chase", number: "2222", kind: "Credit Card", balance: "500.00", name: "card-only.csv")
    get finance_forecast_path
    assert_response :success
    assert_select "#forecast-starting-balance strong", text: "Not available"
    assert_select "#forecast-starting-balance small", text: /Only credit accounts are identified/
    assert_select ".bw-line-chart", count: 0
  end

  test "statement assignment cannot use another user's account or statement" do
    statement = import_unidentified(balance: "75.00", name: "mine.csv")
    other = create(:user)
    account = Finance::BankAccount.create!(user: other, bank_name: "Private Bank", name: "Private checking", last4: "9999", kind: "cash", identity_key: "d" * 64)
    other_statement = Finance::Statement.create!(user: other, filename: "private.csv", currency: "USD", sha256: "c" * 64,
      transaction_count: 1, bank_account: account, closing_balance: "9999.00", closing_balance_on: Date.current,
      balance_observed_on: Date.current)

    assert_no_difference "Finance::BankAccount.count" do
      patch finance_statement_path(statement), params: {bank_account_id: account.id}
    end
    assert_includes [404, 422], response.status
    assert_nil statement.reload.bank_account_id

    patch finance_statement_path(other_statement), params: {bank_account: {
      bank_name: "Other Bank", name: "Changed", last4: "1234", kind: "cash"
    }}
    assert_response :not_found
    assert_equal account.id, other_statement.reload.bank_account_id
    assert_nil @user.finance_profile.reload.balance_source
  end

  test "a newer statement missing its balance makes the cash total visibly incomplete" do
    import_statement(bank: "Chase", number: "1111", balance: "1000.00", date: "2026-10-31", name: "old.csv")
    import_statement(bank: "Chase", number: "1111", balance: nil, date: "2026-11-05", name: "missing-balance.csv")
    import_statement(bank: "Bank of America", number: "2222", balance: "500.00", date: "2026-11-05", name: "known.csv")

    assert_equal BigDecimal("500.00"), @user.finance_profile.reload.current_balance
    get finance_forecast_path
    assert_response :success
    assert_select "#account-balances", text: /missing|incomplete|unavailable|not available|not included|no closing balance/i
    assert_select "#account-balances", text: /1,000\.00/, count: 0
  end

  test "deleting the latest statement falls back within that account and recomputes the sum" do
    older = import_statement(bank: "Chase", number: "1111", balance: "300.00", date: "2026-10-31", name: "old.csv")
    newer = import_statement(bank: "Chase", number: "1111", balance: "450.00", date: "2026-11-05", name: "new.csv")
    import_statement(bank: "Bank of America", number: "2222", balance: "500.00", date: "2026-11-05", name: "other-bank.csv")

    delete finance_statement_path(newer)
    assert_response :redirect
    assert_equal BigDecimal("800.00"), @user.finance_profile.reload.current_balance
    delete finance_statement_path(older)
    assert_response :redirect
    assert_equal BigDecimal("500.00"), @user.finance_profile.reload.current_balance
  end

  test "a person can separate different accounts with the same bank and last four digits" do
    first = import_statement(bank: "Chase", number: "1111", balance: "300.00", name: "checking.csv")
    second = import_unidentified(balance: "450.00", name: "savings.csv")
    patch finance_statement_path(second), params: {bank_account: {
      bank_name: "Chase", name: "Separate savings", last4: "1111", kind: "cash", separate_account: "1"
    }}
    assert_response :redirect
    assert_not_equal first.bank_account_id, second.reload.bank_account_id
    assert_equal "Separate savings", second.bank_account.name
    assert_equal BigDecimal("750.00"), @user.finance_profile.reload.current_balance
  end

  test "a PDF and CSV for one account share the same balance contribution" do
    csv_statement = import_statement(bank: "Chase", number: "1234561111", balance: "300.00", date: "2026-09-30", name: "sep.csv")
    pdf = finance_statement_pdf(["Chase", "Checking Account Number: ****1111",
      "Statement Period: 10/01/2026 - 10/31/2026", "10/05 Coffee -5.00", "Ending Balance $450.00"])
    Tempfile.create(["billie-account", ".pdf"]) do |file|
      file.binmode
      file.write(pdf)
      file.rewind
      post finance_statements_path, params: {file: Rack::Test::UploadedFile.new(file.path, "application/pdf", original_filename: "oct.pdf")}
    end
    assert_redirected_to finance_transactions_path
    assert_equal csv_statement.bank_account_id, @user.finance_statements.find_by!(filename: "oct.pdf").bank_account_id
    assert_equal BigDecimal("450.00"), @user.finance_profile.reload.current_balance
    assert_equal 1, @user.finance_bank_accounts.count
  end

  private

  def import_statement(bank:, number:, balance:, name:, kind: "Checking", date: "2026-11-05", success: true)
    csv = CSV.generate do |rows|
      rows << ["Date", "Description", "Amount", "Balance", "Bank", "Account Number", "Account Type"]
      rows << [date, "Coffee #{date}", "-5.00", balance, bank, number, kind]
    end
    upload(csv, name: name, success: success)
  end

  def import_unidentified(balance:, name:, date: "2026-11-05")
    csv = CSV.generate do |rows|
      rows << ["Date", "Description", "Amount", "Balance"]
      rows << [date, "Coffee #{date}", "-5.00", balance]
    end
    upload(csv, name: name)
  end

  def upload(csv, name:, success: true)
    Tempfile.create(["billie-account-balance", ".csv"]) do |file|
      file.write(csv)
      file.rewind
      post finance_statements_path, params: {file: Rack::Test::UploadedFile.new(file.path, "text/csv", original_filename: name)}
    end
    if success
      assert_redirected_to finance_transactions_path
      @user.finance_statements.find_by!(filename: name)
    end
  end
end
