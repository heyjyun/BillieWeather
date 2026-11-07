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
    assert_equal [BigDecimal("-1200"), BigDecimal(3000)], statement.transactions.order(:id).pluck(:amount)
  end

  test "automatically uses transaction_date when posted_date is also present" do
    csv = "transaction_date,posted_date,Description,Amount\n2025-12-31,2026-01-03,Coffee,-5\n"
    statement = import(csv)
    assert_equal 1, statement.transaction_count
    assert_equal Date.new(2025, 12, 31), statement.transactions.first.booked_on
  end

  test "automatic date priority is independent of header order and naming style" do
    csv = "POSTED_DATE, Date ,Transaction-Date,Description,Amount\n2026-01-03,2026-01-02,2025-12-31,Coffee,-5\n"
    statement = import(csv)
    assert_equal Date.new(2025, 12, 31), statement.transactions.first.booked_on
  end

  test "automatic date detection uses generic date then posting date when transaction date is absent" do
    generic = import("Posting Date,Date,Description,Amount\n2026-01-03,2025-12-31,Coffee,-5\n")
    assert_equal Date.new(2025, 12, 31), generic.transactions.first.booked_on
    posted = import("posted_date,Description,Amount\n2026-01-03,Coffee,-5\n")
    assert_equal Date.new(2026, 1, 3), posted.transactions.first.booked_on
  end

  test "invalid automatically selected dates cannot fall back to a different date column" do
    csv = "transaction_date,posted_date,Description,Amount\n2026-01-02,2026-01-03,Coffee,-5\n,2026-01-04,Rent,-100\n"
    assert_no_difference ["Finance::Statement.count", "Finance::Transaction.count"] do
      error = assert_raises(Finance::StatementImporter::ImportError) { import(csv) }
      assert_includes error.message, "Row 3"
    end
  end

  test "selects the requested date column instead of guessing from header order" do
    csv = "Post Date,Transaction Date,Description,Amount\n2026-01-03,2025-12-31,Coffee,-5\n"
    statement = import(csv, date_column: "transaction_date")
    assert_equal Date.new(2025, 12, 31), statement.transactions.first.booked_on
    assert_equal BigDecimal("-5"), statement.transactions.first.amount
    statement.destroy!
    posted_statement = import(csv, date_column: "post date")
    assert_equal Date.new(2026, 1, 3), posted_statement.transactions.first.booked_on
  end

  test "date choices must match the uploaded file and cannot refer to a description column" do
    csv = "Date,Posting Date,Description,Amount\n2025-12-31,2026-01-03,Coffee,-5\n"
    ["Missing Date", "Description"].each do |choice|
      assert_no_difference ["Finance::Statement.count", "Finance::Transaction.count"] do
        error = assert_raises(Finance::StatementImporter::DateColumnRequired) { import(csv, date_column: choice) }
        assert_equal ["Date", "Posting Date"], error.date_columns
      end
    end
  end

  test "selected dates are validated without falling back to another date column" do
    csv = "Date,Posting Date,Description,Amount\n2026-01-02,2026-01-03,Coffee,-5\n2026-01-04,,Rent,-100\n"
    assert_no_difference ["Finance::Statement.count", "Finance::Transaction.count"] do
      error = assert_raises(Finance::StatementImporter::ImportError) { import(csv, date_column: "Posting Date") }
      assert_includes error.message, "Row 3"
    end
  end

  test "changing the date selection cannot import the same file twice" do
    csv = "Transaction Date,Posting Date,Description,Amount\n2025-12-31,2026-01-03,Coffee,-5\n"
    import(csv, date_column: "Transaction Date")
    assert_no_difference ["Finance::Statement.count", "Finance::Transaction.count"] do
      error = assert_raises(Finance::StatementImporter::ImportError) { import(csv, date_column: "Posting Date") }
      assert_includes error.message, "already been imported"
    end
  end

  test "date selection preserves duplicate header and amount conflict validation" do
    [
      "Date,date,Description,Amount\n2026-01-01,2026-01-02,Coffee,-5\n",
      "Date,Posting Date,Description,Amount,Debit,Credit\n2026-01-01,2026-01-02,Coffee,-5,5,0\n"
    ].each do |csv|
      assert_raises(Finance::StatementImporter::ImportError) { import(csv, date_column: "Date") }
    end
  end

  test "amount type column can specify debit and credit" do
    statement = import("Date,Description,Amount,Type\n2026-11-01,Rent,1200,debit\n2026-11-02,Salary,3000,credit\n")
    assert_equal [BigDecimal("-1200"), BigDecimal(3000)], statement.transactions.order(:id).pluck(:amount)
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

  test "rejects conflicting amount columns and debit credit conflicts" do
    [
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

  def import(csv, **options)
    Finance::StatementImporter.new(user: @user, file: upload(csv), currency: "USD", **options).call
  end
end
