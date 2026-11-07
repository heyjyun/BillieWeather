require "test_helper"
require "tempfile"
require_relative "../support/finance_pdf_fixture"

class FinanceBatchUploadTest < ActionDispatch::IntegrationTest
  include Devise::Test::IntegrationHelpers
  include FinancePdfFixture

  setup do
    @user = create(:user)
    sign_in @user
  end

  test "multiple CSV files import on the first submission using each file's date headers" do
    files = [
      csv_file("bank.csv", "posted_date,transaction_date,Description,Amount\n2026-01-03,2025-12-31,Coffee,-5.00\n"),
      csv_file("card.csv", "Posting Date,Description,Debit,Credit\n01/04/2026,Groceries,12.50,\n")
    ]

    with_uploads(files) do |uploads|
      assert_difference "@user.finance_statements.count", 2 do
        assert_difference "@user.finance_transactions.count", 2 do
          post finance_statements_path, params: {files: uploads}
        end
      end
    end

    assert_response :success
    assert_import_result "bank.csv", "imported"
    assert_import_result "card.csv", "imported"
    assert_equal Date.new(2025, 12, 31), @user.finance_transactions.find_by!(description: "Coffee").booked_on
    assert_equal Date.new(2026, 1, 4), @user.finance_transactions.find_by!(description: "Groceries").booked_on
    assert_equal BigDecimal("-12.50"), @user.finance_transactions.find_by!(description: "Groceries").amount
    assert_select "input[type='file'][name='files[]'][multiple]"
  end

  test "a valid CSV still imports when other files are malformed or already imported" do
    previous_csv = "Date,Description,Amount\n2026-01-01,Previous purchase,-3.00\n"
    with_uploads([csv_file("previous.csv", previous_csv)]) do |uploads|
      post finance_statements_path, params: {file: uploads.first}
    end
    assert_redirected_to finance_transactions_path

    files = [
      csv_file("new.csv", "Date,Description,Amount\n2026-01-02,New purchase,-7.00\n"),
      csv_file("broken.csv", "Date,Description,Amount\n2026-01-03,Invalid amount,not-money\n"),
      csv_file("duplicate.csv", previous_csv)
    ]
    with_uploads(files) do |uploads|
      assert_difference "@user.finance_statements.count", 1 do
        assert_difference "@user.finance_transactions.count", 1 do
          post finance_statements_path, params: {files: uploads}
        end
      end
    end

    assert_response :success
    assert_import_result "new.csv", "imported"
    assert_import_result "broken.csv", "failed"
    assert_import_result "duplicate.csv", "failed"
    assert_equal ["New purchase", "Previous purchase"], @user.finance_transactions.order(:description).pluck(:description)
  end

  test "mixed CSV and PDF uploads import clear files while retaining unclear PDF rows for review" do
    files = [
      csv_file("bank.csv", "Date,Description,Amount\n2026-11-01,Rent,-900.00\n"),
      pdf_file("clear.pdf", ["2026-11-02 Salary +4200.00"]),
      pdf_file("review.pdf", ["2026-11-03 Grocery market 25.50"])
    ]
    with_uploads(files) do |uploads|
      assert_difference "@user.finance_statement_drafts.count", 1 do
        assert_difference "@user.finance_statements.count", 2 do
          assert_difference "@user.finance_transactions.count", 2 do
            post finance_statements_path, params: {files: uploads}
          end
        end
      end
    end

    assert_response :success
    assert_import_result "bank.csv", "imported"
    assert_import_result "clear.pdf", "imported"
    assert_import_result "review.pdf", "review"
    assert_not @user.finance_transactions.exists?(description: "Grocery market")
    draft = @user.finance_statement_drafts.find_by!(filename: "review.pdf")
    assert_select "a[href='#{finance_statement_draft_path(draft)}']"

    rows = draft.rows.each_with_index.to_h do |row, index|
      [index.to_s, row.merge("amount" => "-25.50", "include" => "1")]
    end
    assert_difference "@user.finance_statement_drafts.count", -1 do
      assert_difference "@user.finance_transactions.count", 1 do
        post confirm_finance_statement_draft_path(draft), params: {rows: rows, review_confirmed: "1"}
      end
    end
    assert_redirected_to finance_transactions_path
    assert_equal BigDecimal("-25.50"), @user.finance_transactions.find_by!(description: "Grocery market").amount
    assert_equal "review.pdf", @user.finance_statements.find_by!(filename: "review.pdf").filename
  end

  test "multiple pending PDF reviews remain available after refresh and only belong to the current account" do
    other_user = create(:user)
    private_draft = Finance::StatementDraft.create!(user: other_user, filename: "private-other-account.pdf", sha256: "d" * 64,
      currency: "USD", rows: [{"booked_on" => "2026-11-01", "description" => "Private", "amount" => "-9.00"}],
      warnings: [], expires_at: 20.minutes.from_now)
    files = [
      pdf_file("review-one.pdf", ["2026-11-01 Grocery market 25.50"]),
      pdf_file("review-two.pdf", ["2026-11-02 Pharmacy 18.20"])
    ]
    with_uploads(files) do |uploads|
      assert_difference "@user.finance_statement_drafts.count", 2 do
        assert_no_difference "@user.finance_transactions.count" do
          post finance_statements_path, params: {files: uploads}
        end
      end
    end
    assert_response :success

    get finance_statements_path
    assert_response :success
    @user.finance_statement_drafts.each do |draft|
      assert_select "a[href='#{finance_statement_draft_path(draft)}']"
      assert_includes response.body, draft.filename
    end
    assert_select "a[href='#{finance_statement_draft_path(private_draft)}']", count: 0
    assert_not_includes response.body, private_draft.filename
    get finance_statement_draft_path(private_draft)
    assert_response :not_found
  end

  test "more than ten files rejects the whole batch before importing anything" do
    files = 11.times.map do |index|
      csv_file("bank-#{index}.csv", "Date,Description,Amount\n2026-11-01,Purchase #{index},-1.00\n")
    end

    with_uploads(files) do |uploads|
      assert_no_financial_import do
        post finance_statements_path, params: {files: uploads}
      end
    end

    assert_response :unprocessable_entity
    assert_select "[role='alert']", text: /10/
  end

  test "repeated pending PDFs reuse one review draft without importing transactions" do
    pdf = finance_statement_pdf(["2026-11-01 Grocery market 25.50"])
    files = [
      {filename: "original.pdf", content: pdf, type: "application/pdf"},
      {filename: "same-file.pdf", content: pdf, type: "application/pdf"}
    ]
    with_uploads(files) do |uploads|
      assert_difference "@user.finance_statement_drafts.count", 1 do
        assert_no_difference "@user.finance_transactions.count" do
          post finance_statements_path, params: {files: uploads}
        end
      end
    end

    assert_response :success
    assert_import_result "original.pdf", "review"
    assert_import_result "same-file.pdf", "review"
    draft = @user.finance_statement_drafts.first
    with_uploads([files.last]) do |uploads|
      assert_no_financial_import do
        post finance_statements_path, params: {files: uploads}
      end
    end
    assert_response :success
    assert_select "a[href='#{finance_statement_draft_path(draft)}']"
  end

  test "more than ten MB total rejects the whole batch even when individual files fit" do
    files = [csv_file("valid-first.csv", "Date,Description,Amount\n2026-11-01,Should not import,-1.00\n")]
    padding = "x" * 1_900_000
    6.times { |index| files << csv_file("large-#{index}.csv", padding) }

    with_uploads(files) do |uploads|
      assert_no_financial_import do
        post finance_statements_path, params: {files: uploads}
      end
    end

    assert_response :unprocessable_entity
    assert_select "[role='alert']", text: /10.*MB/i
  end

  test "legacy single file submissions retain their transactions redirect" do
    with_uploads([csv_file("single.csv", "Date,Description,Amount\n2026-11-01,Legacy purchase,-2.00\n")]) do |uploads|
      assert_difference "@user.finance_transactions.count", 1 do
        post finance_statements_path, params: {file: uploads.first}
      end
    end

    assert_redirected_to finance_transactions_path
    assert_includes flash[:notice], "single.csv"
  end

  private

  def csv_file(filename, content)
    {filename: filename, content: content, type: "text/csv"}
  end

  def pdf_file(filename, lines)
    {filename: filename, content: finance_statement_pdf(lines), type: "application/pdf"}
  end

  def with_uploads(files, uploads: [], &block)
    return yield uploads if files.empty?

    file = files.first
    Tempfile.create(["billie-batch", File.extname(file[:filename])]) do |tempfile|
      tempfile.binmode
      tempfile.write(file[:content])
      tempfile.rewind
      upload = Rack::Test::UploadedFile.new(tempfile.path, file[:type], original_filename: file[:filename])
      with_uploads(files.drop(1), uploads: uploads + [upload], &block)
    end
  end

  def assert_import_result(filename, status)
    assert_select "[data-import-status='#{status}']", text: /#{Regexp.escape(filename)}/
  end

  def assert_no_financial_import(&block)
    assert_no_difference ["@user.finance_statements.count", "@user.finance_transactions.count", "@user.finance_statement_drafts.count"], &block
  end
end
