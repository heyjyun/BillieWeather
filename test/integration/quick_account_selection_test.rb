require "test_helper"
require "digest"

# The sign-in page's quick account selection: "Continue as …" (a remembered-account hint that
# still requires real authentication) and the read-only, synthetic Example Account.
class QuickAccountSelectionTest < ActionDispatch::IntegrationTest
  PASSWORD = "Qu1ck!Choice&Personal2026"

  setup do
    @personal = create(:onboarded_user, nickname: "Billie Owner", email: "owner@example.com",
      password: PASSWORD, password_confirmation: PASSWORD)
    @personal_statement = Finance::Statement.create!(user: @personal, filename: "private.csv", currency: "USD",
      sha256: Digest::SHA256.hexdigest("personal"), transaction_count: 1)
    @personal_transaction = Finance::Transaction.create!(user: @personal, statement: @personal_statement,
      booked_on: Date.current - 3, description: "PRIVATE OWNER MERCHANT", amount: -42.5, category: "Shopping")
  end

  teardown do
    ENV.delete("BILLIE_DEMO_ENABLED")
  end

  # --- Sign-in page --------------------------------------------------------------------------

  test "the sign-in page offers both accounts above the ordinary form" do
    seed_demo
    get new_user_session_path
    assert_response :success
    assert_select "h1", "Welcome to BillieWeather"
    assert_select "#personal-account-heading", "Personal Account"
    assert_select "#example-account-heading", /Example Account/
    assert_select "form[action='#{users_demo_session_path}'][method=post] button#try-example-account", /Try Example Account/
    assert_select ".bw-auth-divider", /Or sign in with another account/
    assert_select "form[action='#{user_session_path}'] input[name='user[email]']"
    assert_select "form[action='#{user_session_path}'] input[name='user[password]']"
    # Nothing identifies any account to a visitor this browser has never signed in as.
    assert_no_match(/owner@example\.com|Billie Owner|Continue as/, response.body)
    assert_not_includes response.body, DemoAccount::EMAIL
  end

  test "the Example Account button is hidden until the demo is seeded or when it is disabled" do
    get new_user_session_path
    assert_select "#try-example-account", count: 0

    seed_demo
    ENV["BILLIE_DEMO_ENABLED"] = "false"
    get new_user_session_path
    assert_select "#try-example-account", count: 0
    post users_demo_session_path
    assert_redirected_to new_user_session_path
    assert_equal "The Example Account is not available right now.", flash[:alert]
    get finance_dashboard_path
    assert_redirected_to new_user_session_path
  end

  # --- Ordinary login and "Continue as" ------------------------------------------------------

  test "ordinary email and password login still works and wrong passwords still fail" do
    post user_session_path, params: {user: {email: @personal.email, password: "wrong-password"}}
    assert_response :unprocessable_content
    get finance_dashboard_path
    assert_redirected_to new_user_session_path

    sign_in_with_password
    assert_redirected_to finance_dashboard_path
    follow_redirect!
    assert_response :success
    assert_select ".bw-user strong", "Billie Owner"
    assert_select ".bw-user-kind", "Personal Account"
    assert_select "#demo-banner", count: 0
  end

  test "continue as fills in the remembered email but never signs anyone in" do
    sign_in_with_password
    delete destroy_user_session_path(switch_account: 1)
    assert_redirected_to new_user_session_path

    get new_user_session_path
    assert_select "#continue-as-personal", /Continue as Billie Owner/
    assert_select "#personal-account-identity", /o•••@example\.com/
    assert_equal "", css_select("input[name='user[email]']").first["value"].to_s

    get new_user_session_path(account: "personal")
    assert_response :success
    assert_select "input[name='user[email]'][value='owner@example.com']"
    assert_select "input[name='user[password]'][autofocus]"
    assert_equal "", css_select("input[name='user[password]']").first["value"].to_s
    get finance_dashboard_path
    assert_redirected_to new_user_session_path

    # The password is still required.
    post user_session_path, params: {user: {email: @personal.email, password: ""}}
    get finance_dashboard_path
    assert_redirected_to new_user_session_path
    sign_in_with_password
    assert_redirected_to finance_dashboard_path
  end

  test "a forged or tampered remembered-account cookie is ignored" do
    cookies[RememberedAccount::COOKIE] = {"id" => @personal.id}.to_json
    get new_user_session_path(account: "personal")
    assert_no_match(/Continue as|owner@example\.com/, response.body)
    get finance_dashboard_path
    assert_redirected_to new_user_session_path
  end

  test "not you forgets the remembered account without signing in or out" do
    sign_in_with_password
    delete destroy_user_session_path
    get new_user_session_path
    assert_select "#continue-as-personal", /Billie Owner/

    delete users_remembered_account_path
    assert_redirected_to new_user_session_path
    follow_redirect!
    assert_no_match(/Continue as/, response.body)
  end

  test "remembered accounts that can no longer sign in are not offered" do
    sign_in_with_password
    delete destroy_user_session_path
    @personal.lock_access!
    get new_user_session_path
    assert_no_match(/Continue as/, response.body)
  end

  # --- Example Account -----------------------------------------------------------------------

  test "try example account signs in to synthetic data only" do
    demo = seed_demo
    post users_demo_session_path
    assert_redirected_to finance_dashboard_path
    follow_redirect!
    assert_response :success
    assert_select "#demo-banner", /Example Account/
    assert_select ".bw-user-kind", "Example Account"
    assert_not_includes response.body, DemoAccount::EMAIL

    get finance_transactions_path
    assert_response :success
    assert_match "ACME ANALYTICS PAYROLL", response.body
    assert_no_match(/PRIVATE OWNER MERCHANT/, response.body)

    get edit_finance_transaction_path(@personal_transaction)
    assert_response :not_found
    get finance_report_path
    assert_response :success
    assert_no_match(/PRIVATE OWNER MERCHANT/, response.body)
    get finance_transactions_path(format: :csv)
    assert_no_match(/PRIVATE OWNER MERCHANT/, response.body)

    # The demo was never remembered as a personal account.
    delete destroy_user_session_path(switch_account: 1)
    get new_user_session_path
    assert_no_match(/Continue as/, response.body)
    assert_equal 0, demo.reload.sign_in_count
    assert_nil demo.current_sign_in_ip
  end

  test "the Example Account is read-only on the server" do
    demo = seed_demo
    post users_demo_session_path
    transaction = demo.finance_transactions.first
    category = transaction.category
    counts = finance_counts(demo)

    patch finance_transaction_path(transaction), params: {finance_transaction: {category: "Health"}}
    assert_redirected_to finance_dashboard_path
    assert_equal "The Example Account is read-only, so this change was not saved. Sign in with your own account to make changes.", flash[:alert]
    assert_equal category, transaction.reload.category

    delete finance_financial_data_path, params: {confirm: "DELETE"}
    post finance_categories_path, params: {name: "Hacked"}
    delete finance_statement_path(demo.finance_statements.first)
    patch finance_profile_path, params: {finance_profile: {currency: "EUR"}}
    patch password_finance_settings_path, params: {user: {password: "x"}}
    patch nickname_finance_settings_path, params: {user: {nickname: "Owned"}}
    delete user_registration_path, params: {user: {confirm_email: DemoAccount::EMAIL}}
    post finance_command_execute_path, params: {text: "delete all"}, as: :json
    assert_response :forbidden
    assert_equal "demo_read_only", response.parsed_body["error"]

    assert_equal counts, finance_counts(demo)
    assert_equal DemoAccount::NICKNAME, demo.reload.nickname
    assert User.exists?(demo.id)
    # And none of it reached the personal account.
    assert_equal "Shopping", @personal_transaction.reload.category
    assert_equal 1, @personal.finance_transactions.count
  end

  test "the Example Account cannot become an administrator or sign in any other way" do
    demo = seed_demo
    previous = ENV["DEVELOPER_EMAILS"]
    ENV["DEVELOPER_EMAILS"] = DemoAccount::EMAIL
    assert_not demo.developer?

    post users_demo_session_path
    get admin_root_path
    assert_response :not_found
    delete destroy_user_session_path

    # No password works, on the website or for the apps.
    post user_session_path, params: {user: {email: DemoAccount::EMAIL, password: ""}}
    get finance_dashboard_path
    assert_redirected_to new_user_session_path
    post client_api_v1_session_path, params: {email: DemoAccount::EMAIL, password: "anything"}, as: :json
    assert_response :unauthorized
    assert_raises(ArgumentError) { ClientApi::SessionToken.issue(demo) }
    token = Rails.application.message_verifier("client_api_session").generate(
      {"uid" => demo.id, "salt" => demo.authenticatable_salt}, expires_at: 1.day.from_now, purpose: :client_api_session
    )
    assert_nil ClientApi::SessionToken.authenticate(token)
    assert_no_difference -> { ActionMailer::Base.deliveries.size } do
      demo.send_reset_password_instructions
    end
  ensure
    ENV["DEVELOPER_EMAILS"] = previous
  end

  test "nobody can register or switch to the reserved demo address" do
    assert_no_difference "User.count" do
      post user_registration_path, params: {user: {email: DemoAccount::EMAIL, usage_region: "US",
                                                   password: "Gr33nCloud!Rain&2026", password_confirmation: "Gr33nCloud!Rain&2026"}}
    end
    assert_not build(:user, email: "someone@#{DemoAccount::DOMAIN}").valid?
    @personal.email = DemoAccount::EMAIL
    assert_not @personal.valid?
    assert_includes @personal.errors.attribute_names, :email
  end

  test "trying the demo requires the page's CSRF token" do
    seed_demo
    previous = ActionController::Base.allow_forgery_protection
    ActionController::Base.allow_forgery_protection = true
    post users_demo_session_path
    get finance_dashboard_path
    assert_redirected_to new_user_session_path
  ensure
    ActionController::Base.allow_forgery_protection = previous
  end

  # --- Switching accounts --------------------------------------------------------------------

  test "switching between the personal account and the example account keeps them separate" do
    seed_demo
    sign_in_with_password
    get finance_dashboard_path
    assert_select "#switch-account"

    # Trying the demo while signed in leaves the personal session first.
    post users_demo_session_path
    follow_redirect!
    assert_select "#demo-banner"
    assert_select ".bw-user strong", "Example Account"
    get edit_finance_transaction_path(@personal_transaction)
    assert_response :not_found

    delete destroy_user_session_path(switch_account: 1)
    assert_redirected_to new_user_session_path
    get finance_dashboard_path
    assert_redirected_to new_user_session_path

    get new_user_session_path
    assert_select "#continue-as-personal", /Billie Owner/
    sign_in_with_password
    follow_redirect!
    assert_select "#demo-banner", count: 0
    assert_select ".bw-user strong", "Billie Owner"
    assert_equal 1, @personal.finance_transactions.count
  end

  test "plain log out still goes to the usual page" do
    sign_in_with_password
    delete destroy_user_session_path
    assert_redirected_to root_path
  end

  # --- Languages -----------------------------------------------------------------------------

  test "the account choice is translated into every supported language" do
    seed_demo
    expected = {
      "en" => "Welcome to BillieWeather", "es" => "Te damos la bienvenida a BillieWeather", "ja" => "BillieWeather へようこそ",
      "ko" => "BillieWeather에 오신 것을 환영합니다", "zh-CN" => "欢迎使用 BillieWeather", "zh-TW" => "歡迎使用 BillieWeather"
    }
    assert_equal I18n.available_locales.map(&:to_s).sort, expected.keys.sort
    expected.each do |locale, heading|
      get new_user_session_path(locale: locale)
      assert_select "h1", heading
      assert_select "#try-example-account", I18n.t("billie.quick_access.demo.try", locale: locale)
      assert_select ".bw-auth-divider-strong", I18n.t("billie.quick_access.other_account", locale: locale)
    end
  end

  private

  def seed_demo
    DemoAccount::Seeder.call
  end

  def sign_in_with_password
    post user_session_path, params: {user: {email: @personal.email, password: PASSWORD}}
  end

  def finance_counts(user)
    [user.finance_statements.count, user.finance_transactions.count, user.finance_custom_categories.count,
      user.finance_bank_accounts.count, Finance::Profile.where(user: user).pick(:currency)]
  end
end
