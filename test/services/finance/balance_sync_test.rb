require "test_helper"
require "csv"
require "stringio"
require_relative "../../support/finance_pdf_fixture"

class Finance::BalanceSyncTest < ActiveSupport::TestCase
  include FinancePdfFixture

  setup do
    @user = create(:user)
    @profile = Finance::Profile.create!(user: @user, currency: "USD")
  end

  def import(csv, name: "s.csv", identify: true, bank: "Chase", account_number: "1111", account_kind: "Checking", user: @user)
    if identify
      rows = CSV.parse(csv)
      headers = rows.shift
      csv = CSV.generate do |output|
        output << headers + ["Bank", "Account Number", "Account Type"]
        rows.each { |row| output << row + [bank, account_number, account_kind] }
      end
    end
    io = StringIO.new(csv)
    io.define_singleton_method(:original_filename) { name }
    Finance::StatementImporter.new(user: user, file: io, currency: "USD").call
  end

  test "a Balance column on an oldest-first CSV gives the last row's balance and date" do
    statement = import("Date,Description,Amount,Balance\n2025-10-01,Salary,1000.00,1000.00\n2025-10-05,Coffee,-4.50,\"$995.50\"\n")
    assert_equal BigDecimal("995.50"), statement.closing_balance
    assert_equal Date.new(2025, 10, 5), statement.closing_balance_on
    @profile.reload
    assert_equal BigDecimal("995.50"), @profile.current_balance
    assert_equal "statement", @profile.balance_source
    assert_equal Date.new(2025, 10, 5), @profile.balance_as_of
  end

  test "a newest-first CSV uses the first row, and same-day rows follow the file's order" do
    newest_first = import("Date,Description,Amount,Running Balance\n2025-10-05,B,-5.00,90.00\n2025-10-05,A,-5.00,95.00\n2025-10-01,Salary,100.00,100.00\n")
    assert_equal BigDecimal("90.00"), newest_first.closing_balance
    assert_equal Date.new(2025, 10, 5), newest_first.closing_balance_on
  end

  test "negative and parenthesised balances are kept as negative" do
    statement = import("Date,Description,Amount,Balance\n2025-10-05,Rent,-1400.00,(250.00)\n")
    assert_equal BigDecimal("-250.00"), statement.closing_balance
    assert_equal BigDecimal("-250.00"), @profile.reload.current_balance
    assert @profile.balance_available?
  end

  test "no balance column or unreadable balances never fail the import and leave the balance alone" do
    @profile.update!(current_balance: 10)
    statement = import("Date,Description,Amount\n2025-10-05,Coffee,-4.50\n")
    assert_nil statement.closing_balance
    statement = import("Date,Description,Amount,Balance\n2025-10-06,Tea,-3.00,n/a\n", name: "t.csv")
    assert_nil statement.closing_balance
    assert_equal BigDecimal(10), @profile.reload.current_balance
    assert_nil @profile.balance_source
  end

  test "a balance you entered is never overwritten by a later statement, until you ask" do
    @profile.update!(current_balance: 777, balance_source: "manual", balance_as_of: Date.current)
    import("Date,Description,Amount,Balance\n2025-10-05,Coffee,-4.50,100.00\n")
    assert_equal BigDecimal(777), @profile.reload.current_balance
    assert_equal "manual", @profile.balance_source
  end

  test "the statement with the latest closing date wins regardless of upload order" do
    import("Date,Description,Amount,Balance\n2025-11-05,Coffee,-4.50,200.00\n", name: "nov.csv")
    import("Date,Description,Amount,Balance\n2025-10-05,Coffee,-4.50,100.00\n", name: "oct.csv")
    assert_equal BigDecimal("200.00"), @profile.reload.current_balance
  end

  test "deleting the statement the balance came from resets it, or falls back to an older statement" do
    old = import("Date,Description,Amount,Balance\n2025-10-05,Coffee,-4.50,100.00\n", name: "oct.csv")
    newer = import("Date,Description,Amount,Balance\n2025-11-05,Coffee,-4.50,200.00\n", name: "nov.csv")
    newer.destroy!
    Finance::BalanceSync.call(user: @user)
    assert_equal BigDecimal("100.00"), @profile.reload.current_balance
    old.destroy!
    Finance::BalanceSync.call(user: @user)
    @profile.reload
    assert_equal BigDecimal(0), @profile.current_balance
    assert_nil @profile.balance_source
  end

  test "another account's statements never affect this balance" do
    other = create(:user)
    Finance::Profile.create!(user: other, currency: "USD")
    import("Date,Description,Amount,Balance\n2025-10-05,Coffee,-4.50,999.00\n", name: "x.csv", user: other)
    assert_equal BigDecimal(0), @profile.reload.current_balance
    assert_empty Finance::BalanceSync.summary(user: @user)[:accounts]
  end

  test "PDF ending balance and period date are carried through the draft into the statement" do
    pdf = finance_statement_pdf(["Chase", "Checking Account Number: 1111", "Statement Period: 10/01/2025 - 10/31/2025", "10/05 Coffee -4.50", "Ending Balance $1,234.56"])
    file = StringIO.new(pdf)
    file.define_singleton_method(:original_filename) { "statement.pdf" }
    draft = Finance::PdfStatementExtractor.new(user: @user, file: file, currency: "USD").call
    assert_equal BigDecimal("1234.56"), draft.closing_balance
    assert_equal Date.new(2025, 10, 31), draft.closing_balance_on
    assert_equal "cash", draft.bank_account.kind
    statement = Finance::DraftImport.new(user: @user, draft: draft).call
    assert_equal BigDecimal("1234.56"), statement.closing_balance
    assert_equal draft.bank_account_id, statement.bank_account_id
    assert_equal BigDecimal("1234.56"), @profile.reload.current_balance
    assert_equal Date.new(2025, 10, 31), @profile.balance_as_of
  end

  test "PDF balances: DR is negative, and disagreeing ending balances are ignored" do
    extractor = Finance::PdfStatementExtractor.new(user: @user, file: StringIO.new(""), currency: "USD")
    assert_equal BigDecimal("-50.00"), extractor.send(:detect_closing_balance, "Closing balance 50.00 DR\n")
    assert_equal BigDecimal("-50.00"), extractor.send(:detect_closing_balance, "Closing balance: (50.00)\n")
    assert_equal BigDecimal("75.25"), extractor.send(:detect_closing_balance, "Ending balance 10/31/2025 75.25\nEnding balance 75.25\n")
    assert_nil extractor.send(:detect_closing_balance, "Ending balance 10.00\nEnding balance 20.00\n")
    assert_nil extractor.send(:detect_closing_balance, "New balance 500.00\n")
  end

  test "an identified zero balance is known and can be used to start a forecast" do
    import("Date,Description,Amount,Balance\n2025-10-05,Coffee,-4.50,0.00\n")

    summary = Finance::BalanceSync.summary(user: @user)
    assert_equal BigDecimal("0"), summary[:total]
    assert summary[:complete]
    assert Finance::BalanceSync.statement_balance_available?(@user)
    assert @profile.reload.balance_available?
    assert_equal "statement", @profile.balance_source
    forecast = Finance::CashFlowForecast.new(user: @user).to_h
    assert forecast[:balance_available]
    assert_equal BigDecimal("0"), forecast[:points].first[:balance]
  end

  test "overdrafts reduce the total rather than being omitted or made positive" do
    import("Date,Description,Amount,Balance\n2025-10-05,Rent,-1400.00,(250.00)\n")
    import("Date,Description,Amount,Balance\n2025-10-05,Interest,1.00,100.00\n", name: "savings.csv", bank: "Bank of America", account_kind: "Savings")

    assert_equal BigDecimal("-150.00"), @profile.reload.current_balance
    assert_equal BigDecimal("-150.00"), Finance::BalanceSync.summary(user: @user)[:total]
  end

  test "unknown accounts never produce a forecast from a fabricated zero starting balance" do
    statement = import("Date,Description,Amount,Balance\n#{Date.current.iso8601},Salary,500.00,8500.00\n", identify: false)

    assert_nil statement.bank_account_id
    summary = Finance::BalanceSync.summary(user: @user)
    assert_nil summary[:total]
    refute summary[:complete]
    assert_equal [statement.id], summary[:unassigned_statements].map(&:id)
    refute @profile.reload.balance_available?
    forecast = Finance::CashFlowForecast.new(user: @user).to_h
    assert forecast[:has_history]
    refute forecast[:balance_available]
    assert_empty forecast[:points]
    assert_nil forecast[:projected_balance]
  end

  test "a missing balance on the latest CSV row cannot reuse an earlier readable balance" do
    statement = import("Date,Description,Amount,Balance\n2025-10-01,Salary,1000.00,1000.00\n2025-10-05,Coffee,-4.50,\n")

    assert_nil statement.closing_balance
    assert_nil statement.closing_balance_on
    assert_equal Date.new(2025, 10, 5), statement.balance_observed_on
    summary = Finance::BalanceSync.summary(user: @user)
    assert_nil summary[:total]
    assert_equal "missing_balance", summary[:accounts].first[:status]
    refute @profile.reload.balance_available?
  end

  test "the same last four digits at different banks identify different cash accounts" do
    import("Date,Description,Amount,Balance\n2025-10-05,Coffee,-4.50,100.00\n", bank: "Chase", account_number: "1111")
    import("Date,Description,Amount,Balance\n2025-10-05,Coffee,-4.50,200.00\n", name: "other-bank.csv", bank: "Bank of America", account_number: "1111")

    summary = Finance::BalanceSync.summary(user: @user)
    assert_equal 2, summary[:accounts].length
    assert_equal 2, summary[:accounts].map { |row| row[:account].id }.uniq.length
    assert_equal BigDecimal("300.00"), summary[:total]
    assert_equal BigDecimal("300.00"), @profile.reload.current_balance
  end

  test "future observations are excluded and do not silently fall back to older cash" do
    import("Date,Description,Amount,Balance\n#{(Date.current - 1).iso8601},Coffee,-4.50,100.00\n", name: "current.csv")
    future = import("Date,Description,Amount,Balance\n#{(Date.current + 1).iso8601},Coffee,-4.50,200.00\n", name: "future.csv")

    summary = Finance::BalanceSync.summary(user: @user)
    assert_nil summary[:total]
    assert_equal "future_date", summary[:accounts].first[:status]
    assert_equal future.id, summary[:accounts].first[:statement].id
    assert_nil @profile.reload.balance_source
    refute @profile.balance_available?
  end

  test "an undated balance cannot be ranked as a usable latest cash observation" do
    known = import("Date,Description,Amount,Balance\n2025-10-05,Coffee,-4.50,100.00\n")
    undated = Finance::Statement.create!(user: @user, bank_account: known.bank_account, filename: "undated.pdf", currency: "USD",
      sha256: "e" * 64, transaction_count: 1, closing_balance: "500.00")

    summary = Finance::BalanceSync.call(user: @user)
    assert_nil summary[:total]
    assert_equal "missing_date", summary[:accounts].first[:status]
    assert_equal undated.id, summary[:accounts].first[:statement].id
    assert_nil @profile.reload.balance_source
    refute @profile.balance_available?
  end
end
