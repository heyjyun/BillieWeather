require "test_helper"
require "stringio"
require_relative "../../support/finance_pdf_fixture"

class Finance::PdfStatementExtractorTest < ActiveSupport::TestCase
  include FinancePdfFixture

  setup do
    @user = create(:user)
    Finance::Profile.create!(user: @user, currency: "USD")
  end

  test "real PDF text is extracted to a temporary draft without importing transactions" do
    pdf = finance_statement_pdf([
      "Date Description Amount",
      "2026-11-01 Salary +4,200.00",
      "11/02/2026 Coffee -12.34",
      "11/03/2026 Grocery (23.45)"
    ])
    draft = nil
    assert_no_difference ["Finance::Statement.count", "Finance::Transaction.count"] do
      draft = extract(pdf)
    end
    assert_equal @user.id, draft.user_id
    assert_equal "statement.pdf", draft.filename
    assert_equal Digest::SHA256.hexdigest(pdf), draft.sha256
    assert_equal ["+4200.00", "-12.34", "-23.45"], draft.rows.map { |row| row["amount"] }
    assert_equal "2026-11-02", draft.rows[1]["booked_on"]
    assert_in_delta 30.minutes, draft.expires_at - Time.current, 2
    refute draft.expired?
    assert draft.warnings.any? { |warning| warning.include?("wrapped descriptions") }
  end

  test "unsigned values are blank and dates without years require an explicit year" do
    pdf = finance_statement_pdf(["11/01 Merchant $1,234.56"])
    error = assert_raises(Finance::PdfStatementExtractor::ImportError) { extract(pdf) }
    assert_includes error.message, "statement year"
    draft = extract(pdf, year: 2026)
    assert_equal "2026-11-01", draft.rows.first["booked_on"]
    assert_equal "", draft.rows.first["amount"]
    assert draft.warnings.any? { |warning| warning.include?("no debit/credit sign") }
    assert draft.warnings.any? { |warning| warning.include?("December and January") }
  end

  test "explicit debit and credit markers are preserved but running balances are never chosen" do
    pdf = finance_statement_pdf([
      "11/01/2026 Merchant 12.34 DR",
      "11/02/2026 Payroll 1,200.00 CR",
      "11/03/2026 11/04/2026 Market -42.50 1,157.50",
      "11/01/2026 Opening balance 100.00"
    ])
    draft = extract(pdf)
    assert_equal ["-12.34", "+1200.00", ""], draft.rows.map { |row| row["amount"] }
    assert_equal "Market", draft.rows.last["description"]
    assert draft.warnings.any? { |warning| warning.include?("multiple amount columns") }
    assert draft.warnings.any? { |warning| warning.include?("two dates") }
    assert draft.warnings.any? { |warning| warning.include?("summary line was skipped") }
  end

  test "unsupported or incomplete text remains reviewable without guessing amounts" do
    draft = extract(finance_statement_pdf([
      "11/01/2026 Card purchase -12.34 CR",
      "11/02/2026 Wrapped description",
      "continued line 100.00"
    ]))
    assert_equal ["", ""], draft.rows.map { |row| row["amount"] }
    assert draft.warnings.any? { |warning| warning.include?("conflicting debit/credit") }
    assert draft.warnings.any? { |warning| warning.include?("no clear trailing amount") }
  end

  test "blank text malformed non PDF and oversized files return useful errors" do
    error = assert_raises(Finance::PdfStatementExtractor::ImportError) { extract(finance_statement_pdf([])) }
    assert_includes error.message, "OCR"
    ["not pdf", "%PDF-1.4\nnot a complete file", "%PDF-" + "a" * Finance::PdfStatementExtractor::MAX_BYTES].each do |raw|
      assert_raises(Finance::PdfStatementExtractor::ImportError) { extract(raw) }
    end
  end

  test "page and candidate row limits reject the entire extraction" do
    assert_raises(Finance::PdfStatementExtractor::ImportError) do
      extract(finance_statement_pdf(["2026-11-01 Test -1.00"], pages: 21))
    end
    parser = Finance::PdfStatementExtractor.new(user: @user, file: nil, currency: "USD")
    assert_raises(Finance::PdfStatementExtractor::ImportError) do
      parser.send(:extract_rows, "2026-11-01 Test -1.00\n" * 501)
    end
  end

  test "parser failures and encryption or timeout return safe actionable messages" do
    pdf = finance_statement_pdf(["2026-11-01 Test -1.00"])
    {
      PDF::Reader::EncryptedPDFError => "encrypted",
      Finance::PdfStatementExtractor::ExtractionTimeout => "too long",
      TypeError => "could not be read"
    }.each do |error_class, expected|
      extractor = Finance::PdfStatementExtractor.new(user: @user, file: upload(pdf), currency: "USD")
      extractor.define_singleton_method(:parse_document) { |_raw| raise error_class, "private parser detail" }
      error = assert_raises(Finance::PdfStatementExtractor::ImportError) { extractor.call }
      assert_includes error.message, expected
      refute_includes error.message, "private parser detail"
    end
  end

  test "expired drafts are recognized and replaced without retaining original bytes" do
    old = extract(finance_statement_pdf(["2026-11-01 Coffee -1.00"]))
    travel 31.minutes do
      assert old.expired?
      fresh = extract(finance_statement_pdf(["2026-11-02 Coffee -2.00"]))
      refute Finance::StatementDraft.exists?(old.id)
      assert fresh.persisted?
      refute fresh.attributes.keys.any? { |key| key.match?(/raw|bytes|original_file/) }
    end
  end

  test "PDF confirmation preserves original identity for duplicate detection" do
    pdf = finance_statement_pdf(["2026-11-01 Coffee -1.00"])
    draft = extract(pdf)
    csv = StringIO.new("Date,Description,Amount\n2026-11-01,Coffee,-1.00\n")
    def csv.original_filename = "reviewed.csv"
    statement = Finance::StatementImporter.new(user: @user, file: csv, currency: "USD",
      source_sha256: draft.sha256, source_filename: draft.filename).call
    assert_equal "statement.pdf", statement.filename
    assert_equal draft.sha256, statement.sha256
    assert_raises(Finance::PdfStatementExtractor::ImportError) { extract(pdf) }
    other = create(:user)
    assert Finance::PdfStatementExtractor.new(user: other, file: upload(pdf), currency: "USD").call.persisted?
  end

  private

  def upload(raw)
    io = StringIO.new(raw)
    def io.original_filename = "statement.pdf"
    io
  end

  def extract(raw, year: nil)
    Finance::PdfStatementExtractor.new(user: @user, file: upload(raw), currency: "USD", year: year).call
  end
end
