require "test_helper"
require "stringio"

# A common "one account, one month" export: institution / account_type / account_mask /
# balance_after, plus an internal account_id that is not an account number.
class Finance::CsvExportFormatTest < ActiveSupport::TestCase
  HEADER = "account_holder,customer_id,institution,institution_code,account_id,account_type,account_mask,currency,transaction_id,transaction_date,posted_date,description,amount,balance_after\n"

  setup do
    @user = create(:user)
    Finance::Profile.create!(user: @user, currency: "USD")
  end

  def import(rows, name)
    io = StringIO.new(HEADER + rows)
    io.define_singleton_method(:original_filename) { name }
    Finance::StatementImporter.new(user: @user, file: io, currency: "USD").call
  end

  test "bank, snake_case account type, last four and balance_after are all recognized" do
    checking = import(<<~CSV, "checking.csv")
      Pat Doe,C1,"Wells Fargo Bank, N.A.",wells,K00001,checking,2129,USD,T1,2025-01-02,2025-01-02,Salary,3000.0,3500.0
      Pat Doe,C1,"Wells Fargo Bank, N.A.",wells,K00001,checking,2129,USD,T2,2025-01-03,2025-01-04,Grocery,-50.5,3449.5
    CSV
    savings = import(<<~CSV, "savings.csv")
      Pat Doe,C1,"Wells Fargo Bank, N.A.",wells,K00002,savings,4030,USD,T3,2025-01-31,2025-01-31,Interest,1.25,10001.25
    CSV
    card = import(<<~CSV, "card.csv")
      Pat Doe,C1,"JPMorgan Chase Bank, N.A.",chase,K00003,credit_card,3565,USD,T4,2025-01-05,2025-01-06,Coffee,-4.0,4.0
    CSV

    assert_equal BigDecimal("3449.5"), checking.closing_balance
    assert_equal Date.new(2025, 1, 3), checking.closing_balance_on
    kinds = Finance::BankAccount.where(user: @user).to_h { |a| [[a.bank_name, a.last4], a.kind] }
    assert_equal({["Wells Fargo", "2129"] => "cash", ["Wells Fargo", "4030"] => "cash", ["Chase", "3565"] => "credit"}, kinds)
    assert [checking, savings, card].all?(&:bank_account_id)

    summary = Finance::BalanceSync.summary(user: @user)
    assert_equal BigDecimal("13450.75"), summary[:total]
    assert summary[:complete]
    profile = Finance::Profile.find_by(user: @user)
    assert_equal BigDecimal("13450.75"), profile.current_balance
    assert_equal "statement", profile.balance_source
  end

  test "an internal account_id never makes an otherwise clear statement ambiguous" do
    statement = import(<<~CSV, "one.csv")
      Pat Doe,C1,Discover Bank,discover,K99999,checking,0007,USD,T1,2025-02-01,2025-02-01,Deposit,10.0,110.0
    CSV
    assert statement.bank_account.present?
    assert_equal "0007", statement.bank_account.last4
  end

  test "uploading an older statement again fills in the missing account and balance without importing twice" do
    rows = "Pat Doe,C1,Wells Fargo Bank,wells,K1,checking,2129,USD,T1,2025-01-02,2025-01-02,Salary,3000.0,3500.0\n"
    csv = HEADER + rows
    # Simulate an import made before these columns were recognized.
    statement = import(rows, "jan.csv")
    statement.update_columns(bank_account_id: nil, closing_balance: nil, closing_balance_on: nil)
    Finance::Profile.find_by(user: @user).update!(current_balance: 0, balance_source: nil, balance_as_of: nil)

    io = StringIO.new(csv)
    io.define_singleton_method(:original_filename) { "jan.csv" }
    importer = Finance::StatementImporter.new(user: @user, file: io, currency: "USD")
    assert_no_difference "Finance::Transaction.count" do
      assert_no_difference "Finance::Statement.count" do
        importer.call
      end
    end
    assert importer.refreshed?
    statement.reload
    assert_equal BigDecimal("3500.0"), statement.closing_balance
    assert statement.bank_account.present?
    assert_equal BigDecimal("3500.0"), Finance::Profile.find_by(user: @user).current_balance

    # Once everything is saved, an identical upload is a plain duplicate again.
    again = StringIO.new(csv)
    again.define_singleton_method(:original_filename) { "jan.csv" }
    error = assert_raises(Finance::StatementImporter::ImportError) { Finance::StatementImporter.new(user: @user, file: again, currency: "USD").call }
    assert_includes error.message, "already been imported"
  end

  test "re-uploading never replaces an account or balance that is already saved" do
    rows = "Pat Doe,C1,Wells Fargo Bank,wells,K1,checking,2129,USD,T1,2025-01-02,2025-01-02,Salary,3000.0,3500.0\n"
    csv = HEADER + rows
    statement = import(rows, "jan.csv")
    statement.update_columns(closing_balance: nil, closing_balance_on: nil)
    original_account = statement.bank_account_id
    io = StringIO.new(csv)
    io.define_singleton_method(:original_filename) { "jan.csv" }
    Finance::StatementImporter.new(user: @user, file: io, currency: "USD").call
    assert_equal original_account, statement.reload.bank_account_id
    assert_equal BigDecimal("3500.0"), statement.closing_balance
  end

  test "credit card balances are totalled separately as money owed and never mixed into cash" do
    import("Pat Doe,C1,Wells Fargo Bank,wells,K1,checking,2129,USD,T1,2025-01-02,2025-01-02,Salary,3000.0,3500.0\n", "checking.csv")
    import("Pat Doe,C1,\"Capital One, N.A.\",capone,K2,credit_card,7038,USD,T2,2025-01-03,2025-01-04,Store,-40.0,40.0\nPat Doe,C1,\"Capital One, N.A.\",capone,K2,credit_card,7038,USD,T3,2025-01-05,2025-01-06,Gas,-10.0,50.0\n", "capone.csv")
    import("Pat Doe,C1,Discover Bank,discover,K3,credit_card,2039,USD,T4,2025-01-07,2025-01-08,Cafe,-5.5,5.5\n", "discover.csv")

    summary = Finance::BalanceSync.summary(user: @user)
    assert_equal BigDecimal("3500.0"), summary[:total]
    assert_equal BigDecimal("55.5"), summary[:credit_total]
    assert_equal 2, summary[:credit_count]
    owed = summary[:accounts].select { |row| row[:status] == "excluded_credit" }.to_h { |row| [row[:account].last4, row[:credit_balance]] }
    assert_equal({"7038" => BigDecimal("50.0"), "2039" => BigDecimal("5.5")}, owed)
    assert_nil summary[:accounts].find { |row| row[:status] == "known" }[:credit_balance]
  end

  test "with no credit cards there is no owed total" do
    import("Pat Doe,C1,Wells Fargo Bank,wells,K1,checking,2129,USD,T1,2025-01-02,2025-01-02,Salary,3000.0,3500.0\n", "checking.csv")
    summary = Finance::BalanceSync.summary(user: @user)
    assert_nil summary[:credit_total]
    assert_equal 0, summary[:credit_count]
  end
end
