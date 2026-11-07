require "test_helper"
require "csv"

class Finance::StatementAccountIdentityTest < ActiveSupport::TestCase
  test "CSV account metadata groups masked and unmasked versions of the same account" do
    headers = ["Date", "Description", "Amount", "Bank_Name", "Account_Number", "Account_Type"]
    first = Finance::StatementAccountIdentity.from_csv(headers: headers,
      rows: [["2026-11-01", "Coffee", "-5", "JPMorgan Chase Bank, N.A.", "1234567890", "Checking"]])
    masked = Finance::StatementAccountIdentity.from_csv(headers: headers,
      rows: [["2026-10-01", "Coffee", "-5", "Chase", "****7890", "checking"]])
    assert_equal first[:account_key], masked[:account_key]
    assert_match(/\A[0-9a-f]{64}\z/, first[:account_key])
    assert_equal "Chase", first[:bank_name]
    assert_equal "cash", first[:account_kind]
    assert_equal "7890", first[:account_last4]
    assert_equal "Checking ••••7890", first[:account_name]
    refute_includes first.inspect, "1234567890"
  end

  test "CSV keys differ across banks and account kinds" do
    headers = ["Bank", "Account Number", "Account Type"]
    checking = Finance::StatementAccountIdentity.from_csv(headers: headers, rows: [["Chase", "1234", "Checking"]])
    savings = Finance::StatementAccountIdentity.from_csv(headers: headers, rows: [["Wells Fargo", "1234", "Savings"]])
    card = Finance::StatementAccountIdentity.from_csv(headers: headers, rows: [["Chase", "1234", "Credit Card"]])
    assert_equal 3, [checking, savings, card].map { |identity| identity[:account_key] }.uniq.length
    assert_equal "credit", card[:account_kind]
  end

  test "CSV never infers a bank account from a transaction description or filename" do
    rows = CSV.parse("Date,Description,Amount,Balance\n2026-11-01,Chase Checking account 1234,50,500\n", headers: true)
    identity = Finance::StatementAccountIdentity.from_csv(headers: rows.headers, rows: rows)
    assert_nil identity[:account_key]
    assert_nil identity[:bank_name]
    assert_nil identity[:account_last4]
    assert_equal "unknown", identity[:account_kind]
  end

  test "CSV mixed accounts and invalid metadata remain unresolved" do
    headers = ["Institution", "Account Number", "Account Type"]
    [[['Chase', '1234', 'Checking'], ['Chase', '5678', 'Checking']],
      [['Chase', '1234', 'Checking'], ['Wells Fargo', '1234', 'Checking']],
      [['Chase', '1234', 'Checking'], ['Chase', 'not available', 'Checking']],
      [['Chase', '1234', 'Checking'], ['Chase', '1234', 'Credit Card']]].each do |rows|
      identity = Finance::StatementAccountIdentity.from_csv(headers: headers, rows: rows)
      assert_nil identity[:account_key]
      assert_equal "unknown", identity[:account_kind]
    end
  end

  test "CSV supports explicit local banks and hash rows without retaining arbitrary account names" do
    headers = ["Institution", "Account Number", "Account Name"]
    identity = Finance::StatementAccountIdentity.from_csv(headers: headers,
      rows: [{"Institution" => "Community Credit Union", "Account Number" => "XXXX-7654", "Account Name" => "Jane Doe savings 1234567654"}])
    assert_equal "Community Credit Union", identity[:bank_name]
    assert_equal "Savings ••••7654", identity[:account_name]
    assert_equal "cash", identity[:account_kind]
    assert identity[:account_key]
    refute_includes identity.inspect, "Jane Doe"
    refute_includes identity.inspect, "1234567654"
  end

  test "PDF reads a labelled checking account and ignores bank names in transactions" do
    identity = Finance::StatementAccountIdentity.from_pdf(text: <<~TEXT)
      JPMorgan Chase Bank, N.A.
      Chase Total Checking
      Account Number: 1234567890
      Statement period 10/01/2026 through 10/31/2026
      10/05/2026 Transfer to Wells Fargo -25.00
      Ending balance $975.00
    TEXT
    assert_equal "cash", identity[:account_kind]
    assert_equal "Chase", identity[:bank_name]
    assert_equal "7890", identity[:account_last4]
    assert identity[:account_key]
  end

  test "PDF uses the same key as CSV and accepts masked account suffixes" do
    pdf = Finance::StatementAccountIdentity.from_pdf(text: "Bank of America\nSavings Account # XXXX XXXX 1234\nEnding balance 50.00\n")
    csv = Finance::StatementAccountIdentity.from_csv(headers: ["Bank", "Account Number", "Account Type"],
      rows: [["Bank of America", "1234", "Savings"]])
    assert_equal csv[:account_key], pdf[:account_key]
    assert_equal "Savings ••••1234", pdf[:account_name]
  end

  test "PDF marks credit card and loan balances as non cash" do
    card = Finance::StatementAccountIdentity.from_pdf(text: "Capital One\nCredit card statement\nAccount ending in 9876\nMinimum payment $25\n")
    assert_equal "credit", card[:account_kind]
    assert_equal "9876", card[:account_last4]
    assert card[:account_key]
  end

  test "PDF with several accounts or kinds is unresolved even when balances match" do
    identity = Finance::StatementAccountIdentity.from_pdf(text: "Wells Fargo\nChecking account number 1234\nSavings account number 5678\nEnding balance 50.00\nEnding balance 50.00\n")
    assert_nil identity[:account_key]
    assert_equal "unknown", identity[:account_kind]
    assert_nil identity[:account_last4]
    both = Finance::StatementAccountIdentity.from_pdf(text: "Wells Fargo\nChecking account 1234\nCredit card statement\n")
    assert_nil both[:account_key]
    assert_equal "unknown", both[:account_kind]
  end

  test "PDF without a labelled account or a recognizable institution needs review" do
    ["Chase\nChecking statement\nRouting number 123456789\nBalance 1234.56\n",
      "Checking account number 123456789\nEnding balance 100.00\n"].each do |text|
      assert_nil Finance::StatementAccountIdentity.from_pdf(text: text)[:account_key]
    end
  end

  test "manual account details normalize to future imports" do
    manual = Finance::StatementAccountIdentity.from_details(bank_name: "JPMorgan Chase Bank, N.A.",
      account_name: "My checking account", account_last4: "1234", account_kind: "cash")
    pdf = Finance::StatementAccountIdentity.from_pdf(text: "Chase\nChecking account 1234\n")
    assert_equal manual[:account_key], pdf[:account_key]
    assert_equal "Checking ••••1234", manual[:account_name]
    assert_equal "Chase", manual[:bank_name]
    assert_nil Finance::StatementAccountIdentity.from_details(bank_name: "Chase", account_last4: "1234", account_kind: "unknown")[:account_key]
  end

  test "credit union name does not turn savings into a credit card" do
    identity = Finance::StatementAccountIdentity.from_pdf(text: "Bank: Community Credit Union\nSavings account number 1234\n")
    assert_equal "cash", identity[:account_kind]
    assert identity[:account_key]
  end

  test "CSV different full account numbers sharing a suffix are unresolved" do
    identity = Finance::StatementAccountIdentity.from_csv(headers: ["Bank", "Account Number", "Account Type"],
      rows: [["Chase", "11111234", "Checking"], ["Chase", "99991234", "Checking"]])
    assert_nil identity[:account_key]
    assert_equal "unknown", identity[:account_kind]
    refute_includes identity.inspect, "11111234"
    refute_includes identity.inspect, "99991234"
  end

  test "PDF different full account numbers sharing a suffix are unresolved" do
    identity = Finance::StatementAccountIdentity.from_pdf(text: "Chase\nChecking account number 11111234\nChecking account number 99991234\n")
    assert_nil identity[:account_key]
    assert_equal "unknown", identity[:account_kind]
  end

  test "CSV full card number with repeated masked or short suffix representations remains one account" do
    identity = Finance::StatementAccountIdentity.from_csv(headers: ["Bank", "Card Number", "Account Type"],
      rows: [["Chase", "4444 3333 2222 1234", "Credit Card"], ["Chase", "XXXX-XXXX-XXXX-1234", "Credit Card"], ["Chase", "1234", "Credit Card"]])
    assert identity[:account_key]
    assert_equal "credit", identity[:account_kind]
    assert_equal "1234", identity[:account_last4]
    refute_includes identity.inspect, "4444"
  end

  test "PDF full and masked card representations remain one account" do
    identity = Finance::StatementAccountIdentity.from_pdf(text: "Chase\nCredit card statement\nCard number 4444 3333 2222 1234\nAccount ending in 1234\nAccount number XXXX XXXX XXXX 1234\n")
    assert identity[:account_key]
    assert_equal "credit", identity[:account_kind]
    assert_equal "1234", identity[:account_last4]
  end

  test "PDF account on a later page prevents assigning a combined statement to the first account" do
    text = "Chase\nChecking account number 11111234\nEnding balance 50.00\n" + ("Statement information\n" * 110) +
      "Savings account number 99995678\nEnding balance 50.00\n"
    identity = Finance::StatementAccountIdentity.from_pdf(text: text)
    assert_nil identity[:account_key]
    assert_nil identity[:account_last4]
    assert_equal "unknown", identity[:account_kind]
  end

  test "PDF later full account number colliding on suffix remains unresolved" do
    text = "Chase\nChecking account number 11111234\nEnding balance 50.00\n" + ("Statement information\n" * 110) +
      "Checking account number 99991234\nEnding balance 50.00\n"
    identity = Finance::StatementAccountIdentity.from_pdf(text: text)
    assert_nil identity[:account_key]
    assert_equal "unknown", identity[:account_kind]
    refute_includes identity.inspect, "11111234"
    refute_includes identity.inspect, "99991234"
  end

  test "PDF later repetition of the same full or masked account is not ambiguous" do
    text = "Chase\nChecking account number 11111234\n" + ("Statement information\n" * 110) +
      "Checking account number ****1234\nChecking account number 11111234\n"
    identity = Finance::StatementAccountIdentity.from_pdf(text: text)
    assert identity[:account_key]
    assert_equal "cash", identity[:account_kind]
    assert_equal "1234", identity[:account_last4]
  end
end
