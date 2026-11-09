require "test_helper"
require_relative "../support/billie_method_stub"

class PrivacyDataDeletionTest < ActionDispatch::IntegrationTest
  include Devise::Test::IntegrationHelpers
  include BillieMethodStub

  PASSWORD = "Gr33nCloud!Rain&2026"

  setup do
    @user = create(:onboarded_user, password: PASSWORD, password_confirmation: PASSWORD, usage_region: "US")
    seed_finance(@user, "4")
    @other = create(:onboarded_user)
    @other_transaction = seed_finance(@other, "5")
  end

  # Gives a person one record in every finance table and returns one of their transactions.
  def seed_finance(user, digit)
    Finance::Profile.create!(user: user, currency: "USD", cash_on_hand: "10.00", tax_country: "United States")
    account = Finance::BankAccount.create!(user: user, identity_key: digit * 64, bank_name: "Chase", name: "Checking", last4: "1234", kind: "cash")
    statement = Finance::Statement.create!(user: user, bank_account: account, filename: "s.csv", currency: "USD", sha256: digit * 64, transaction_count: 1)
    Finance::StatementDraft.create!(user: user, bank_account: account, filename: "d.pdf", sha256: digit * 64, currency: "USD",
      rows: [{"description" => "Draft row", "booked_on" => Date.current.iso8601, "amount" => "-1.00"}], expires_at: 10.minutes.from_now)
    Finance::MerchantRule.create!(user: user, merchant_key: "coffee bar", category: "Food & dining")
    Finance::CustomCategory.create!(user: user, name: "Pets")
    Finance::Insight.create!(user: user, source: "rules", content: {"summary" => "x"}, generated_at: Time.current)
    Finance::Transaction.create!(user: user, statement: statement, booked_on: Date.current, description: "Coffee bar", amount: "-4.00", category: "Food & dining")
  end

  def finance_counts(user)
    Finance::DataDeletion::MODELS.to_h { |model| [model.table_name, model.where(user_id: user.id).count] }
  end

  test "settings show just two buttons; the explanations and forms live in dialogs that start closed" do
    sign_in @user
    get finance_settings_path, params: {locale: "en"}
    assert_response :success
    assert_select "#settings-privacy > .bw-privacy-buttons button[data-dialog-open]", count: 2
    assert_select "#settings-privacy > .bw-privacy-buttons button[data-dialog-open='privacy-delete-data-dialog']", text: "Delete my financial data"
    assert_select "#settings-privacy > .bw-privacy-buttons button[data-dialog-open='privacy-delete-account-dialog']"
    # Nothing long is shown on the page itself: every list and form is inside a closed dialog.
    assert_select "#settings-privacy > p", count: 0
    assert_select "#settings-privacy > .bw-privacy-action", count: 0
    assert_select "#settings-privacy dialog[open]", count: 0
    assert_select "dialog#privacy-delete-data-dialog form[action='#{finance_financial_data_path}']"
    assert_select "dialog#privacy-delete-account-dialog form[action='#{user_registration_path}']"
    assert_equal "settings-privacy", css_select("main section.bw-panel").last["id"], "privacy is the last section"
  end

  test "settings explain both actions, warn to export first and link to the export" do
    sign_in @user
    get finance_settings_path
    assert_response :success
    assert_select "#settings-privacy" do
      assert_select "a[href='#{finance_report_path}']"
      assert_select "form[action='#{finance_financial_data_path}'] input[name='_method'][value=delete]"
      assert_select "form[action='#{user_registration_path}'] input[name='_method'][value=delete]"
      assert_select "form[action='#{user_registration_path}'] input[name='user[current_password]'][required]"
      assert_select "input[name='financial_data[confirm_email]'][required]"
    end
    assert_includes response.body, "not erased immediately"
    get finance_settings_path, params: {locale: "ja"}
    assert_no_match(/translation_missing|Translation missing/, response.body)
  end

  test "financial data is not deleted without the typed email" do
    sign_in @user
    assert_no_difference -> { Finance::Transaction.count } do
      delete finance_financial_data_path, params: {financial_data: {confirm_email: "wrong@example.com"}}
    end
    assert_redirected_to finance_settings_path(anchor: "settings-privacy")
    assert_includes flash[:alert], "doesn't match"
    delete finance_financial_data_path
    delete finance_financial_data_path, params: {financial_data: {confirm_email: [@user.email]}}
    assert finance_counts(@user).values.all?(&:positive?)
  end

  test "deleting financial data removes every finance record but keeps the login and other people's data" do
    sign_in @user
    other_before = finance_counts(@other)
    delete finance_financial_data_path, params: {financial_data: {confirm_email: " #{@user.email.upcase} "}}
    assert_redirected_to finance_settings_path(anchor: "settings-privacy")
    assert_equal "Your financial data has been deleted. Your account is still active.", flash[:notice]

    assert finance_counts(@user).values.all?(&:zero?), finance_counts(@user).inspect
    assert User.exists?(@user.id)
    assert @user.reload.valid_password?(PASSWORD)
    assert_equal 1, @user.teams.count
    assert_equal other_before, finance_counts(@other)
    assert Finance::Transaction.exists?(@other_transaction.id)

    get finance_dashboard_path
    assert_response :success, "the app starts fresh with a new empty profile"
    assert_equal BigDecimal(0), Finance::Profile.find_by!(user: @user).cash_on_hand
  end

  test "financial data deletion is all or nothing" do
    sign_in @user
    # Insights are deleted after transactions, so this proves earlier deletes are rolled back.
    failing = ->(*) { raise ActiveRecord::StatementInvalid, "simulated" }
    stub_method(Finance::Insight, :where, failing) do
      delete finance_financial_data_path, params: {financial_data: {confirm_email: @user.email}}
    end
    assert_includes flash[:alert], "Nothing was removed"
    assert finance_counts(@user).values.all?(&:positive?)
  end

  test "signed-out visitors cannot delete anything" do
    assert_no_difference -> { Finance::Transaction.count } do
      delete finance_financial_data_path, params: {financial_data: {confirm_email: @user.email}}
    end
    assert_redirected_to new_user_session_path
    assert_no_difference -> { User.count } do
      delete user_registration_path, params: {user: {confirm_email: @user.email, current_password: PASSWORD}}
    end
  end

  test "account deletion needs the typed email and the current password" do
    sign_in @user
    assert_no_difference -> { User.count } do
      delete user_registration_path
      delete user_registration_path, params: {user: {confirm_email: @user.email, current_password: "wrong"}}
      delete user_registration_path, params: {user: {confirm_email: "x@example.com", current_password: PASSWORD}}
    end
    assert_redirected_to finance_settings_path(anchor: "settings-privacy")
    assert finance_counts(@user).values.all?(&:positive?)
  end

  test "deleting the account removes the user, their finance data and personal team, then signs out" do
    team = @user.teams.sole
    Invitation.create!(team: team, email: "pending@example.com", from_membership: @user.memberships.sole, membership: Membership.new(team: team, user_email: "pending@example.com"))
    other_before = finance_counts(@other)
    sign_in @user

    delete user_registration_path, params: {user: {confirm_email: @user.email, current_password: PASSWORD}}
    assert_redirected_to billie_home_path
    assert_equal "Your account and financial data have been deleted.", flash[:notice]
    refute User.exists?(@user.id)
    assert finance_counts(@user).values.all?(&:zero?)
    refute Team.exists?(team.id)
    refute Membership.where(team_id: team.id).exists?
    refute Invitation.where(team_id: team.id).exists?
    assert_equal other_before, finance_counts(@other)
    assert User.exists?(@other.id)

    get finance_dashboard_path
    assert_redirected_to new_user_session_path
  end

  test "accounts sharing a team with someone else are not deleted" do
    team = @user.teams.sole
    Membership.create!(team: team, user: @other, role_ids: [], user_email: @other.email)
    sign_in @user
    get finance_settings_path
    assert_select "#privacy-account-blocked", text: /share the team/
    assert_select "form[action='#{user_registration_path}']", count: 0

    assert_no_difference -> { User.count } do
      delete user_registration_path, params: {user: {confirm_email: @user.email, current_password: PASSWORD}}
    end
    assert_includes flash[:alert], "share the team"
    assert Team.exists?(team.id)
    assert finance_counts(@user).values.all?(&:positive?)
  end

  test "Google sign-up accounts confirm with their email because they never saw a password" do
    @user.update_columns(google_uid: "google-subject-delete")
    sign_in @user
    get finance_settings_path
    assert_select "#privacy-delete-account input[name='user[current_password]']", count: 0
    delete user_registration_path, params: {user: {confirm_email: @user.email}}
    refute User.exists?(@user.id)
  end

  test "Bullet Train's user and team endpoints cannot delete someone else" do
    sign_in @user
    other_team = @other.teams.sole
    assert_no_difference -> { User.count } do
      delete "/account/users/#{@other.id}"
    rescue AbstractController::ActionNotFound, ActiveRecord::RecordNotFound, CanCan::AccessDenied
      nil
    end
    assert_no_difference -> { Team.count } do
      delete "/account/teams/#{other_team.id}"
    rescue ActiveRecord::RecordNotFound, CanCan::AccessDenied
      nil
    end
    assert User.exists?(@other.id)
    assert_equal other_team, @other.teams.sole
  end
end
