require "test_helper"

# P0-3: overlapping statements of the same account must not double-count, and an import keeps
# the original description and an explicit kind (P0-2, P0-4).
class Finance::DuplicateImportTest < ActiveSupport::TestCase
  setup do
    @user = create(:onboarded_user, usage_region: "US")
  end

  def import(name, csv, account: nil)
    file = Rack::Test::UploadedFile.new(StringIO.new(csv), "text/csv", original_filename: name)
    importer = Finance::StatementImporter.new(user: @user, file: file, currency: "USD", bank_account: account)
    [importer.call, importer]
  end

  test "an overlapping export of the same account adds only the new rows" do
    account = Finance::BankAccount.create!(user: @user, manual: true, name: "Card", account_type: "credit_card")
    import("october.csv", "Date,Description,Amount\n2026-10-03,ZXQ GROCERY #12,-120.00\n2026-10-09,ZXQ OUTFITTERS,-80.00\n", account: account)
    statement, importer = import("ninety-days.csv", "Date,Description,Amount\n2026-10-03,zxq  grocery #12,-120.00\n2026-10-09,ZXQ OUTFITTERS,-80.00\n2026-10-15,ZXQ OUTFITTERS RETURN,30.00\n2026-10-28,PAYMENT RECEIVED - THANK YOU,170.00\n", account: account)
    assert_equal 2, importer.duplicates_skipped
    assert_equal 2, statement.transaction_count
    assert_equal 4, @user.finance_transactions.count
    refund = @user.finance_transactions.find_by!(original_description: "ZXQ OUTFITTERS RETURN")
    assert_equal ["refund", "Uncategorized"], [refund.kind, refund.category], "money in on a card is a refund (no keyword names the store)"
    payment = @user.finance_transactions.find_by!(original_description: "PAYMENT RECEIVED - THANK YOU")
    assert_equal ["card_payment", "Transfers"], [payment.kind, payment.category]
    snapshot = Finance::Snapshot.new(user: @user).to_h
    assert_equal BigDecimal(0), snapshot[:income], "a card refund or repayment is not income"
    assert_equal BigDecimal(170), snapshot[:expenses], "120 + 80 - 30"
  end

  test "two genuine identical purchases are both kept; a third file with both is fully recognized" do
    import("a.csv", "Date,Description,Amount\n2026-10-05,ZXQ COFFEE,-3.50\n")
    _, importer = import("b.csv", "Date,Description,Amount\n2026-10-05,ZXQ COFFEE,-3.50\n2026-10-05,ZXQ COFFEE,-3.50\n")
    assert_equal 1, importer.duplicates_skipped
    assert_equal 2, @user.finance_transactions.count
    error = assert_raises(Finance::StatementImporter::ImportError) { import("c.csv", "Date,Description,Amount\n2026-10-05,ZXQ COFFEE,-3.50\n2026-10-05,ZXQ COFFEE,-3.50\n") }
    assert_match(/already/i, error.message)
  end

  test "a possible duplicate is kept and linked for review" do
    import("a.csv", "Date,Description,Amount\n2026-10-07,ZXQMART STORE 0042 CHICAGO,-25.99\n")
    _, importer = import("b.csv", "Date,Description,Amount\n2026-10-07,ZXQMART STORE #42,-25.99\n")
    assert_equal 1, importer.duplicates_flagged
    link = Finance::TransactionLink.sole
    assert_equal %w[duplicate_of suggested auto], [link.link_type, link.status, link.decided_by]
  end

  test "the same purchase on another account is not a duplicate" do
    a = Finance::BankAccount.create!(user: @user, manual: true, name: "A", account_type: "checking")
    b = Finance::BankAccount.create!(user: @user, manual: true, name: "B", account_type: "checking")
    import("a.csv", "Date,Description,Amount\n2026-10-05,ZXQ COFFEE,-3.50\n", account: a)
    _, importer = import("b.csv", "date,description,amount\n2026-10-05,ZXQ COFFEE,-3.50\n", account: b)
    assert_equal 0, importer.duplicates_skipped
  end

  test "editing the description never changes the original" do
    import("a.csv", "Date,Description,Amount\n2026-10-31,ZELLE TO SAM Q,-60.00\n")
    entry = @user.finance_transactions.sole
    entry.update!(description: "Dinner split with Sam")
    entry.update(original_description: "tampered") rescue nil
    assert_equal "ZELLE TO SAM Q", entry.reload.original_description
    assert_equal "Dinner split with Sam", entry.description
  end
end
