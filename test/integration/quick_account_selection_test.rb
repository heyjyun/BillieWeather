require "test_helper"
require "digest"

# The sign-in page's two quick login buttons: the read-only, synthetic Example Account and the
# one personal account configured on the server (see PersonalAccount).
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

  setup do
    ENV["BILLIE_PERSONAL_ACCOUNT_EMAIL"] = @personal.email
  end

  teardown do
    %w[BILLIE_DEMO_ENABLED BILLIE_PERSONAL_ACCOUNT_EMAIL BILLIE_DEV_PASSWORDLESS_LOGIN].each { |name| ENV.delete(name) }
  end

  # --- Sign-in page --------------------------------------------------------------------------

  test "the sign-in page offers both quick login buttons above the ordinary form" do
    seed_demo
    get new_user_session_path
    assert_response :success
    assert_select "h1", "Welcome to BillieWeather"
    assert_select "#personal-account-heading", "Personal Account"
    assert_select "#example-account-heading", /Example Account/
    assert_select "form[action='#{users_demo_session_path}'][method=post] button#quick-login-example", "Quick Login — Example"
    assert_select "form[action='#{users_personal_session_path}'][method=post] button#quick-login-personal", "Quick Login — Billie Owner"
    # Real buttons, not links to the form below.
    assert_select "a[href*='#sign-in-form']", count: 0
    assert_select ".bw-auth-divider", /Or sign in with another account/
    assert_select "form[action='#{user_session_path}'] input[name='user[email]']"
    assert_select "form[action='#{user_session_path}'] input[name='user[password]']"
    # Neither account's address is written into the page.
    assert_not_includes response.body, @personal.email
    assert_not_includes response.body, DemoAccount::EMAIL
  end

  test "the Example Account button is hidden until the demo is seeded or when it is disabled" do
    get new_user_session_path
    assert_select "#quick-login-example", count: 0

    seed_demo
    ENV["BILLIE_DEMO_ENABLED"] = "false"
    get new_user_session_path
    assert_select "#quick-login-example", count: 0
    post users_demo_session_path
    assert_redirected_to new_user_session_path
    assert_equal "The Example Account is not available right now.", flash[:alert]
    get finance_dashboard_path
    assert_redirected_to new_user_session_path
  end

  # --- Ordinary login ------------------------------------------------------------------------------

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

  # --- Quick Login — personal account -------------------------------------------------------

  test "the personal quick login is hidden until an account is configured on the server" do
    ENV.delete("BILLIE_PERSONAL_ACCOUNT_EMAIL")
    get new_user_session_path
    assert_select "#quick-login-personal", count: 0
    post users_personal_session_path, params: {password: PASSWORD}
    assert_redirected_to new_user_session_path
    assert_equal "That account is not available right now.", flash[:alert]
    assert_not_signed_in

    # The shared demo can never be the personal target.
    seed_demo
    ENV["BILLIE_PERSONAL_ACCOUNT_EMAIL"] = DemoAccount::EMAIL
    get new_user_session_path
    assert_select "#quick-login-personal", count: 0
  end

  test "outside development the personal quick login is a real password sign-in for that one account" do
    assert_not Rails.env.development?
    get new_user_session_path
    assert_select "form[action='#{users_personal_session_path}'][method=post] input[type=password][name=password]"
    assert_select "form[action='#{users_personal_session_path}'] button#quick-login-personal", "Quick Login — Billie Owner"
    assert_select "form[action='#{users_personal_session_path}'] input[name=email]", count: 0
    # The address stays on the server.
    assert_not_includes response.body, @personal.email

    # Anonymous requests without the right password get nothing.
    post users_personal_session_path
    assert_redirected_to new_user_session_path
    assert_not_signed_in
    post users_personal_session_path, params: {password: "wrong-password"}
    assert_equal "Incorrect password. Please try again.", flash[:alert]
    assert_not_signed_in
    assert_equal 1, @personal.reload.failed_attempts
    # The request cannot pick another account, even with that account's own password.
    other = create(:onboarded_user, email: "other@example.com", password: "Oth3r!Account&2026", password_confirmation: "Oth3r!Account&2026")
    post users_personal_session_path, params: {password: "Oth3r!Account&2026", email: other.email, user: {email: other.email}}
    assert_not_signed_in

    post users_personal_session_path, params: {password: PASSWORD}
    assert_redirected_to finance_dashboard_path
    follow_redirect!
    assert_response :success
    assert_select ".bw-user strong", "Billie Owner"
    assert_select ".bw-user-kind", "Personal Account"
    assert_select "#demo-banner", count: 0
    assert_match "PRIVATE OWNER MERCHANT", get_body(finance_transactions_path)
  end

  test "the passwordless personal quick login works only in development, from this computer, with the flag" do
    ENV["BILLIE_DEV_PASSWORDLESS_LOGIN"] = "true"
    # The flag alone does nothing outside development (here: test, then production).
    post users_personal_session_path
    assert_not_signed_in
    with_rails_env("production") do
      get new_user_session_path
      assert_select "#quick-login-personal-password"
      post users_personal_session_path
      assert_not_signed_in
    end

    with_rails_env("development") do
      # Not from this computer: refused.
      post users_personal_session_path, env: {"REMOTE_ADDR" => "203.0.113.7"}
      assert_not_signed_in
      get new_user_session_path, env: {"REMOTE_ADDR" => "203.0.113.7"}
      assert_select "#quick-login-personal-password"

      # Flag off: refused.
      ENV["BILLIE_DEV_PASSWORDLESS_LOGIN"] = "false"
      post users_personal_session_path
      assert_not_signed_in

      ENV["BILLIE_DEV_PASSWORDLESS_LOGIN"] = "true"
      get new_user_session_path
      assert_select "#quick-login-personal-password", count: 0
      assert_select "form[action='#{users_personal_session_path}'][method=post] button#quick-login-personal", "Quick Login — Billie Owner"
      post users_personal_session_path
      assert_redirected_to finance_dashboard_path
      follow_redirect!
      assert_select ".bw-user strong", "Billie Owner"
    end
  end

  test "a locked personal account cannot use the quick login" do
    @personal.lock_access!
    get new_user_session_path
    assert_select "#quick-login-personal", count: 0
    post users_personal_session_path, params: {password: PASSWORD}
    assert_not_signed_in
  end

  test "the personal quick login requires the page's CSRF token" do
    previous = ActionController::Base.allow_forgery_protection
    ActionController::Base.allow_forgery_protection = true
    post users_personal_session_path, params: {password: PASSWORD}
    assert_not_signed_in
  ensure
    ActionController::Base.allow_forgery_protection = previous
  end

  # --- Example Account -----------------------------------------------------------------------

  test "quick login example signs in to synthetic data only" do
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
    assert_not build(:user, email: "Example@Example.com").valid?
    assert build(:user, email: "someone-else@example.com").valid?
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

    # Quick Login — personal leaves the demo session.
    post users_demo_session_path
    post users_personal_session_path, params: {password: PASSWORD}
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
      assert_select "#quick-login-example", I18n.t("billie.quick_access.demo.quick_login", locale: locale)
      assert_select "#quick-login-personal", I18n.t("billie.quick_access.personal.quick_login", name: "Billie Owner", locale: locale)
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

  def assert_not_signed_in
    get finance_dashboard_path
    assert_redirected_to new_user_session_path
  end

  def get_body(path)
    get path
    response.body
  end

  def with_rails_env(name)
    previous = Rails.env
    Rails.env = name
    yield
  ensure
    Rails.env = previous
  end

  def finance_counts(user)
    [user.finance_statements.count, user.finance_transactions.count, user.finance_custom_categories.count,
      user.finance_bank_accounts.count, Finance::Profile.where(user: user).pick(:currency)]
  end
end
