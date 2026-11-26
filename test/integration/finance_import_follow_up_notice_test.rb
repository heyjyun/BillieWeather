require "test_helper"
require "tempfile"

# S3 (four-agent audit): a CSV that was saved although the clean-up after it failed says so in the notice,
# and the log names the error without row contents. Synthetic data only.
class FinanceImportFollowUpNoticeTest < ActionDispatch::IntegrationTest
  include Devise::Test::IntegrationHelpers
  include BillieModules::SignInWithAllModules

  setup do
    @user = create(:user)
    sign_in @user
  end

  def upload(csv, name)
    Tempfile.create(["billie-follow-up", ".csv"]) do |file|
      file.write(csv)
      file.rewind
      post finance_statements_path, params: {file: Rack::Test::UploadedFile.new(file.path, "text/csv", original_filename: name)}
    end
  end

  test "the saved import is reported as imported, with a note that the clean-up will run again" do
    original = Finance::Categorizer.method(:recategorize_uncategorized!)
    Finance::Categorizer.define_singleton_method(:recategorize_uncategorized!) do |**|
      raise ActiveRecord::StatementInvalid, "PG::CheckViolation: ERROR:  synthetic\nDETAIL:  Failing row contains (Synthetic secret shop)."
    end
    log = StringIO.new
    previous = Rails.logger
    Rails.logger = ActiveSupport::Logger.new(log)
    begin
      upload("Date,Description,Amount\n2026-11-01,Synthetic secret shop,-4.50\n", "follow-up.csv")
    ensure
      Rails.logger = previous
      Finance::Categorizer.define_singleton_method(:recategorize_uncategorized!, original)
    end
    assert_redirected_to finance_transactions_path
    assert_includes flash[:notice], I18n.t("billie.backend.import_follow_up_failed")
    assert_equal 1, @user.finance_statements.count
    line = log.string.lines.grep(/follow-up failed/).join
    assert_match(/follow-up failed \(ActiveRecord::StatementInvalid: PG::CheckViolation: ERROR:  synthetic\)/, line)
    refute_includes line, "Synthetic secret shop", "row values from the DETAIL line are never logged"
  end

  test "an ordinary import has no such note" do
    upload("Date,Description,Amount\n2026-11-02,Synthetic bakery,-3.00\n", "plain.csv")
    assert_redirected_to finance_transactions_path
    refute_includes flash[:notice], I18n.t("billie.backend.import_follow_up_failed")
  end
end
