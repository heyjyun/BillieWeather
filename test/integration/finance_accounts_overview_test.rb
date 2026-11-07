require "test_helper"
require "csv"
require "tempfile"

class FinanceAccountsOverviewTest < ActionDispatch::IntegrationTest
  include Devise::Test::IntegrationHelpers

  setup do
    @user = create(:user)
    sign_in @user
    import(bank: "Chase", number: "1111", kind: "Checking", balance: "1000.00", name: "chase.csv")
    import(bank: "Bank of America", number: "2222", kind: "Savings", balance: "2500.00", name: "boa.csv")
    import(bank: "Capital One", number: "3333", kind: "Credit Card", balance: "300.00", name: "capone.csv")
    import(bank: "Discover Bank", number: "4444", kind: "Credit Card", balance: "120.50", name: "discover.csv")
  end

  def account(bank)
    Finance::BankAccount.find_by!(user_id: @user.id, bank_name: bank)
  end

  test "the dashboard groups cash accounts and credit cards with totals" do
    get finance_dashboard_path
    assert_response :success

    assert_select "#cash-accounts li[data-account-kind='cash']", count: 2
    assert_select "#cash-accounts", text: /Chase/
    assert_select "#cash-accounts", text: /Bank of America/
    assert_select "#cash-accounts", text: /Checking/
    assert_select "#cash-accounts", text: /Savings/
    assert_select "#cash-accounts", text: /\$1,000\.00/
    assert_select "#cash-accounts", text: /\$2,500\.00/
    assert_select "#cash-on-hand .bw-account-amount", text: /\$0\.00.*Not entered yet/m
    assert_select "#total-cash strong", text: "$3,500.00"

    assert_select "#credit-accounts li[data-account-kind='credit']", count: 2
    assert_select "#credit-accounts", text: /Capital One/
    assert_select "#credit-accounts", text: /Owed \$300\.00/
    assert_select "#credit-accounts", text: /Owed \$120\.50/
    assert_select "#total-credit-owed strong", text: "$420.50"
    assert_select "#total-credit-owed", text: /2 cards/
    # Credit card debt is never part of cash.
    assert_select "#cash-accounts", text: /Capital One/, count: 0
  end

  test "cash on hand is typed in, is added to the total, and is not a bank balance" do
    patch finance_profile_path, params: {finance_profile: {cash_on_hand: "125.50"}, return_to: "dashboard"}
    assert_redirected_to finance_dashboard_path(anchor: "accounts")
    profile = @user.finance_profile.reload
    assert_equal BigDecimal("125.50"), profile.cash_on_hand
    assert_equal Date.current, profile.cash_on_hand_on
    assert_equal "statement", profile.balance_source, "typing cash on hand must not switch the bank balance to manual"
    assert_equal BigDecimal("3500.00"), profile.current_balance

    get finance_dashboard_path
    assert_select "#cash-on-hand .bw-account-amount", text: /\$125\.50/
    assert_select "#total-cash strong", text: "$3,625.50"
    assert_select "#cash-on-hand form input[name='finance_profile[cash_on_hand]']"
  end

  test "cash on hand rejects negative and sub-cent amounts" do
    patch finance_profile_path, params: {finance_profile: {cash_on_hand: "50.00"}, return_to: "dashboard"}
    ["-5", "10.005", "abc"].each do |value|
      patch finance_profile_path, params: {finance_profile: {cash_on_hand: value}, return_to: "dashboard"}
      assert_redirected_to finance_dashboard_path(anchor: "accounts")
      follow_redirect!
      assert_select "[role='alert']"
      assert_equal BigDecimal("50.00"), @user.finance_profile.reload.cash_on_hand, "#{value.inspect} must not be saved"
    end
  end

  test "total cash counts cash on hand even before any statement balance is known" do
    other = create(:user)
    sign_out @user
    sign_in other
    patch finance_profile_path, params: {finance_profile: {cash_on_hand: "75.00"}, return_to: "dashboard"}
    get finance_dashboard_path
    assert_select "#total-cash strong", text: "$75.00"
    assert_select "#credit-accounts", text: /No credit cards identified yet/
  end

  test "a name you type always wins, everywhere, and survives later statements" do
    chase = account("Chase")
    original = chase.auto_name
    patch finance_bank_account_path(chase), params: {bank_account: {custom_name: "  My   main  checking "}}
    assert_redirected_to finance_dashboard_path(anchor: "accounts")
    assert_equal "My main checking", chase.reload.custom_name

    get finance_dashboard_path
    assert_select "#cash-accounts li[data-account-id='#{chase.id}'] .bw-account-main > strong", text: "My main checking"
    assert_select "#cash-accounts li[data-account-id='#{chase.id}']", text: /#{Regexp.escape(original)}/ # the detected name stays visible as a hint
    get finance_forecast_path
    assert_select "#account-balances", text: /My main checking/
    get finance_statements_path
    assert_select "body", text: /My main checking/

    import(bank: "Chase", number: "1111", kind: "Checking", balance: "900.00", date: "2026-11-06", name: "chase-next.csv")
    assert_equal 1, Finance::BankAccount.where(user_id: @user.id, bank_name: "Chase").count
    assert_equal "My main checking", chase.reload.custom_name

    patch finance_bank_account_path(chase), params: {bank_account: {custom_name: "   "}}
    assert_nil chase.reload.custom_name
    assert_equal original, chase.display_name
  end

  test "names are limited and checked, and one account cannot be renamed by another user" do
    chase = account("Chase")
    patch finance_bank_account_path(chase), params: {bank_account: {custom_name: "x" * 61}}
    follow_redirect!
    assert_select "[role='alert']"
    assert_nil chase.reload.custom_name
    patch finance_bank_account_path(chase), params: {bank_account: {custom_name: "Bad\u0007name"}}
    assert_nil chase.reload.custom_name

    sign_out @user
    intruder = create(:user)
    sign_in intruder
    patch finance_bank_account_path(chase), params: {bank_account: {custom_name: "Hacked"}}
    assert_response :not_found
    assert_nil chase.reload.custom_name
  end

  test "names are shown as text, never as markup" do
    chase = account("Chase")
    patch finance_bank_account_path(chase), params: {bank_account: {custom_name: "<script>alert(1)</script>"}}
    get finance_dashboard_path
    assert_not_includes response.body, "<script>alert(1)</script>"
    assert_includes response.body, "&lt;script&gt;alert(1)&lt;/script&gt;"
  end

  private

  def import(bank:, number:, kind:, balance:, name:, date: "2026-11-05")
    csv = CSV.generate do |rows|
      rows << ["Date", "Description", "Amount", "Balance", "Bank", "Account Number", "Account Type"]
      rows << [date, "Coffee #{name}", "-5.00", balance, bank, number, kind]
    end
    Tempfile.create(["billie-overview", ".csv"]) do |file|
      file.write(csv)
      file.rewind
      post finance_statements_path, params: {file: Rack::Test::UploadedFile.new(file.path, "text/csv", original_filename: name)}
    end
    assert_redirected_to finance_transactions_path, "#{name} should import"
  end
end
