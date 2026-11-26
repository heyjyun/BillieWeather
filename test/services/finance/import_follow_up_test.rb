require "test_helper"
require "stringio"

# Audit A-06 (four-agent audit 2026-11-25): what runs after an import has committed (recategorizing older
# rows, the balance) can fail without the saved import being reported as failed. Synthetic data only.
class Finance::ImportFollowUpTest < ActiveSupport::TestCase
  setup do
    @user = create(:user)
    Finance::Profile.create!(user: @user, currency: "USD")
  end

  def upload(csv, name = "statement.csv")
    io = StringIO.new(csv)
    io.define_singleton_method(:original_filename) { name }
    io
  end

  def with_failing(target, method)
    original = target.method(method)
    target.define_singleton_method(method) { |**| raise ActiveRecord::RecordInvalid.new(Finance::Profile.new) }
    yield
  ensure
    target.define_singleton_method(method, original)
  end

  test "a failing balance update after the commit returns the saved statement and says so" do
    importer = Finance::StatementImporter.new(user: @user, file: upload("Date,Description,Amount\n2026-11-01,Synthetic coffee,-4.50\n"), currency: "USD")
    statement = with_failing(Finance::BalanceSync, :call) { importer.call }
    assert statement.persisted?
    assert importer.follow_up_failed?
    assert_equal 1, Finance::Transaction.where(user_id: @user.id).count
    # The same file again is a duplicate, as it should be: the first import did succeed.
    error = assert_raises(Finance::StatementImporter::ImportError) do
      Finance::StatementImporter.new(user: @user, file: upload("Date,Description,Amount\n2026-11-01,Synthetic coffee,-4.50\n"), currency: "USD").call
    end
    assert_equal I18n.t("billie.backend.statement_duplicate"), error.message
  end

  test "a failing recategorization after the commit does not fail the import either" do
    importer = Finance::StatementImporter.new(user: @user, file: upload("Date,Description,Amount\n2026-11-02,Synthetic bakery,-3.00\n"), currency: "USD")
    statement = with_failing(Finance::Categorizer, :recategorize_uncategorized!) { importer.call }
    assert statement.persisted?
    assert importer.follow_up_failed?
  end

  test "a reviewed PDF draft is imported and removed even when the follow-up fails" do
    draft = Finance::StatementDraft.create!(user: @user, filename: "synthetic.pdf", sha256: "c" * 64, currency: "USD",
      rows: [{"booked_on" => "2026-11-03", "description" => "Synthetic shop", "amount" => "-7.00"}], expires_at: 30.minutes.from_now)
    statement = with_failing(Finance::BalanceSync, :call) { Finance::DraftImport.new(user: @user, draft: draft).call }
    assert statement.persisted?
    refute Finance::StatementDraft.exists?(draft.id)
  end

  test "inside a caller's own transaction the follow-up error still rolls that file back, as an ImportError" do
    importer = Finance::StatementImporter.new(user: @user, file: upload("Date,Description,Amount\n2026-11-05,Synthetic gift,-9.00\n"), currency: "USD")
    error = assert_no_difference ["Finance::Statement.count", "Finance::Transaction.count"] do
      with_failing(Finance::BalanceSync, :call) do
        assert_raises(Finance::StatementImporter::ImportError) { Finance::Statement.transaction { importer.call } }
      end
    end
    assert_match(/import/i, error.message)
  end

  test "an ordinary import reports no follow-up failure" do
    importer = Finance::StatementImporter.new(user: @user, file: upload("Date,Description,Amount\n2026-11-04,Synthetic fuel,-30.00\n"), currency: "USD")
    importer.call
    refute importer.follow_up_failed?
  end
end
