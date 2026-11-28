require "test_helper"
require "csv"
require "tempfile"

# The Accounts & Assets table data (Finance::AccountTableData) and the reorder endpoint.
class FinanceAccountsTableTest < ActionDispatch::IntegrationTest
  include Devise::Test::IntegrationHelpers
  include BillieModules::SignInWithFullSidebar

  setup do
    @user = create(:user)
    @other = create(:user)
    sign_in @user
    get finance_accounts_path # creates the USD profile
  end

  def account(name, type, balance, **attrs)
    Finance::BankAccount.create!({user: @user, manual: true, name: name, custom_name: name, account_type: type, opening_balance: balance || 0,
                                  balance_pending: balance.nil?, currency: "USD"}.merge(attrs))
  end

  def table
    get finance_accounts_path
    assert_response :success
    JSON.parse(css_select("#accounts-table").first["data-table"])
  end

  def row(data, name) = data["rows"].find { |r| r["name"] == name } || flunk("no row #{name}")

  test "rows keep each account's currency, sign and real balance dates" do
    today = Date.current
    account("Everyday", "checking", 1200, opening_balance_on: today - 3, balance_snapshot: true, bank_name: "Synthetic Bank", last4: "4821")
    account("Card", "credit_card", -215.40, opening_balance_on: today - 50, balance_snapshot: true)
    account("Travel", "cash", 280, currency: "EUR", opening_balance_on: today - 1, balance_snapshot: true)
    account("Loan to a friend", "receivable", 500)
    account("Collectibles", "other", nil)
    data = table

    everyday = row(data, "Everyday")
    assert_equal [120_000, "USD", "Synthetic Bank", "4821", (today - 3).iso8601, "manual"],
      everyday.values_at("balance", "currency", "institution", "last4", "confirmedOn", "confirmedBy")
    assert_equal [-21_540, true], row(data, "Card").values_at("balance", "liability")
    assert_equal [28_000, "EUR"], row(data, "Travel").values_at("balance", "currency")
    # No date was ever given for this balance, and updated_at is never used as one.
    assert_nil row(data, "Loan to a friend")["confirmedOn"]
    assert_nil row(data, "Collectibles")["balance"]
    assert_equal %w[USD EUR], data["positions"].map { |p| p["currency"] }
    assert_equal [28_000], data["positions"].last["position"]["holdings"].map { |h| h["balance"] }
    assert_select "#net-worth", /Net worth/
    assert_select "#account-#{everyday["id"]}", /Everyday/
  end

  test "a balance adjustment is the latest confirmation; the latest entry date is kept apart" do
    wallet = account("Wallet", "cash", 100, opening_balance_on: Date.current - 40, balance_snapshot: true)
    post adjust_finance_account_path(wallet), params: {balance: "80", on: (Date.current - 2).iso8601}
    data = row(table, "Wallet")
    assert_equal [8_000, (Date.current - 2).iso8601, "manual", (Date.current - 2).iso8601], data.values_at("balance", "confirmedOn", "confirmedBy", "lastEntryOn")
    assert_not data["canDelete"]
  end

  test "an imported account takes its balance and date from its latest statement" do
    csv = CSV.generate { |rows|
      rows << ["Date", "Description", "Amount", "Balance", "Bank", "Account Number", "Account Type"]
      rows << [(Date.current - 2).iso8601, "Coffee", "-5.00", "5200.00", "Chase", "4821", "Checking"]
    }
    Tempfile.create(["accounts-table", ".csv"]) do |file|
      file.write(csv)
      file.rewind
      post finance_statements_path, params: {file: Rack::Test::UploadedFile.new(file.path, "text/csv", original_filename: "chase.csv")}
    end
    imported = @user.finance_bank_accounts.find_by!(bank_name: "Chase")
    data = table["rows"].find { |r| r["id"] == imported.id.to_s }
    assert_equal [520_000, "imported", "statement", (Date.current - 2).iso8601], data.values_at("balance", "origin", "confirmedBy", "confirmedOn")
  end

  test "archived accounts stay in net worth when included, and leave liquid assets" do
    account("Active", "checking", 100)
    account("Closed", "savings", 50, archived_at: Time.current)
    holdings = table["positions"].first["position"]["holdings"]
    assert_equal [[false, true], [true, true]], holdings.map { |h| [h["archived"], h["included"]] }
  end

  test "reorder saves the given order and refuses another person's account" do
    a, b, c = account("A", "cash", 1), account("B", "cash", 1), account("C", "cash", 1)
    patch reorder_finance_accounts_path, params: {ids: [c.id, a.id, b.id]}, as: :json
    assert_response :no_content
    assert_equal %w[C A B], @user.finance_bank_accounts.ordered.map(&:display_name)

    theirs = Finance::BankAccount.create!(user: @other, manual: true, name: "Not mine", account_type: "cash")
    patch reorder_finance_accounts_path, params: {ids: [a.id, theirs.id]}, as: :json
    assert_response :unprocessable_entity
    assert_equal %w[C A B], @user.finance_bank_accounts.ordered.map(&:display_name)
    patch reorder_finance_accounts_path, params: {ids: [a.id, a.id]}, as: :json
    assert_response :unprocessable_entity
  end
end
