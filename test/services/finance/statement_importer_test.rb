require "test_helper"
require "stringio"

class Finance::StatementImporterTest < ActiveSupport::TestCase
  setup do
    @user = create(:user)
    Finance::Profile.create!(user: @user, currency: "USD")
  end

  test "imports exact decimals with BOM aliases quoted amounts and month first dates" do
    statement = import("\uFEFFPosting Date,Memo,Amount\n11/06/2026,Salary,\"$1,234.56\"\n2026-11-05,Coffee,($12.34)\n")
    assert_equal 2, statement.transaction_count
    assert_equal BigDecimal("1234.56"), statement.transactions.order(:id).first.amount
    assert_equal BigDecimal("-12.34"), statement.transactions.order(:id).last.amount
    assert_equal Date.new(2026, 11, 6), statement.transactions.order(:id).first.booked_on
    assert_equal "Food & dining", statement.transactions.order(:id).last.category
  end

  test "debit and credit columns have explicit opposite signs" do
    statement = import("Date,Description,Debit,Credit\n2026-11-01,Rent,1200.00,\n2026-11-02,Salary,,3000.00\n")
    assert_equal [BigDecimal("-1200"), BigDecimal("3000")], statement.transactions.order(:id).pluck(:amount)
  end

  test "amount type column can specify debit and credit" do
    statement = import("Date,Description,Amount,Type\n2026-11-01,Rent,1200,debit\n2026-11-02,Salary,3000,credit\n")
    assert_equal [BigDecimal("-1200"), BigDecimal("3000")], statement.transactions.order(:id).pluck(:amount)
  end

  test "a bad row rolls back the complete statement" do
    assert_no_difference ["Finance::Statement.count", "Finance::Transaction.count"] do
      error = assert_raises(Finance::StatementImporter::ImportError) do
        import("Date,Description,Amount\n2026-11-01,Valid,-10\n2026-02-30,Bad date,-20\n")
      end
      assert_includes error.message, "Row 3"
    end
  end

  test "rejects malformed money instead of silently rounding or converting" do
    ["12.345", "1e3", "NaN", "--10", "1,23.45", "", "10000000000000"].each do |amount|
      assert_raises(Finance::StatementImporter::ImportError) do
        import("Date,Description,Amount\n2026-11-01,Invalid,\"#{amount}\"\n")
      end
    end
    assert_equal 0, Finance::Statement.where(user: @user).count
  end

  test "duplicate statement detection is scoped to the account but repeated rows are kept" do
    csv = "Date,Description,Amount\n2026-11-01,Coffee,-5\n2026-11-01,Coffee,-5\n"
    assert_equal 2, import(csv).transactions.count
    assert_raises(Finance::StatementImporter::ImportError) { import(csv) }
    second_user = create(:user)
    statement = Finance::StatementImporter.new(user: second_user, file: upload(csv), currency: "USD").call
    assert_equal 2, statement.transactions.count
  end

  test "rejects ambiguous columns and debit credit conflicts" do
    [
      "Date,Posting Date,Description,Amount\n2026-11-01,2026-11-01,Test,-5\n",
      "Date,Description,Amount,Debit,Credit\n2026-11-01,Test,-5,5,0\n",
      "Date,Description,Debit,Credit\n2026-11-01,Test,5,10\n",
      "Date,Description,Debit,Credit\n2026-11-01,Test,-5,0\n"
    ].each do |csv|
      assert_raises(Finance::StatementImporter::ImportError) { import(csv) }
    end
  end

  test "mixed currencies cannot silently combine" do
    assert_raises(Finance::StatementImporter::ImportError) do
      import("Date,Description,Amount,Currency\n2026-11-01,Test,-5,CAD\n")
    end
    assert_raises(Finance::StatementImporter::ImportError) do
      Finance::StatementImporter.new(user: @user, file: upload("Date,Description,Amount\n2026-11-01,Test,-5\n"), currency: "CAD").call
    end
    assert_raises(Finance::StatementImporter::ImportError) do
      import("Date,Description,Amount\n2026-11-01,Test,-€5\n")
    end
  end

  test "rejects binary oversized and excessive row files" do
    assert_raises(Finance::StatementImporter::ImportError) { import("\0binary") }
    assert_raises(Finance::StatementImporter::ImportError) { import("a" * (Finance::StatementImporter::MAX_BYTES + 1)) }
    csv = "Date,Description,Amount\n" + ("2026-11-01,Coffee,-5\n" * (Finance::StatementImporter::MAX_ROWS + 1))
    assert_raises(Finance::StatementImporter::ImportError) { import(csv) }
  end

  private

  def upload(csv)
    io = StringIO.new(csv)
    def io.original_filename = "statement.csv"
    io
  end

  def import(csv)
    Finance::StatementImporter.new(user: @user, file: upload(csv), currency: "USD").call
  end
end
