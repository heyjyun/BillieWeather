# Agent A repro tests (Phase 1, read-only audit). Synthetic users and rows only; run against a disposable
# local PostgreSQL (see findings.md section E). Passing assertions CONFIRM current behavior.
require File.expand_path("../../../../../../test/test_helper", __dir__)
require "stringio"

class AgentAServerImportTest < ActiveSupport::TestCase
  setup do
    @user = create(:user)
    Finance::Profile.create!(user: @user, currency: "USD")
  end

  def upload(csv, name = "statement.csv")
    io = StringIO.new(csv)
    io.define_singleton_method(:original_filename) { name }
    io
  end

  # A-06: work done AFTER the import transaction committed (recategorize + BalanceSync) is inside the same
  # rescue as the import itself, so a failure there is reported as "import failed" although it is saved.
  test "A-06 a post-commit failure is reported as a failed import while the statement is stored" do
    invalid = ActiveRecord::RecordInvalid.new(Finance::Profile.new)
    original = Finance::BalanceSync.method(:call)
    Finance::BalanceSync.define_singleton_method(:call) { |**| raise invalid }
    raised = begin
      assert_raises(Finance::StatementImporter::ImportError) do
        Finance::StatementImporter.new(user: @user, file: upload("Date,Description,Amount\n2026-11-01,Synthetic coffee,-4.50\n"), currency: "USD").call
      end
    ensure
      Finance::BalanceSync.define_singleton_method(:call, original)
    end
    assert_match(/import/i, raised.message)
    assert_equal 1, Finance::Statement.where(user_id: @user.id).count, "the statement was committed anyway"
    assert_equal 1, Finance::Transaction.where(user_id: @user.id).count
    # The person retries and is told it is a duplicate.
    retry_error = assert_raises(Finance::StatementImporter::ImportError) do
      Finance::StatementImporter.new(user: @user, file: upload("Date,Description,Amount\n2026-11-01,Synthetic coffee,-4.50\n"), currency: "USD").call
    end
    assert_equal I18n.t("billie.backend.statement_duplicate"), retry_error.message
  end

  # A-07: rows from two DIFFERENT unidentified accounts (plain Date/Description/Amount CSVs) are treated as
  # the same account; an identical row in the second file is silently skipped, not offered for review.
  test "A-07 identical rows from two unidentified-account CSVs are silently dropped" do
    Finance::StatementImporter.new(user: @user, file: upload("Date,Description,Amount\n2026-11-03,SYNTH STREAMING,-15.49\n", "card-a.csv"), currency: "USD").call
    importer = Finance::StatementImporter.new(user: @user, file: upload("Date,Description,Amount\n2026-11-03,SYNTH STREAMING,-15.49\n2026-11-04,SYNTH BAKERY,-3.00\n", "card-b.csv"), currency: "USD")
    statement = importer.call
    assert_nil statement.bank_account_id
    assert_equal 1, importer.duplicates_skipped
    assert_equal 0, importer.duplicates_flagged
    assert_equal 1, Finance::Transaction.where(user_id: @user.id, description: "SYNTH STREAMING").count
  end
end
