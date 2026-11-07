require "test_helper"
require "nokogiri"
require "uri"

class SessionCsrfTest < ActionDispatch::IntegrationTest
  PASSWORD = "FreshF0rm!ExistingAccount&2026"

  setup do
    @previous_forgery_protection = ActionController::Base.allow_forgery_protection
    ActionController::Base.allow_forgery_protection = true
    @user = create(:onboarded_user, password: PASSWORD, password_confirmation: PASSWORD)
  end

  teardown do
    ActionController::Base.allow_forgery_protection = @previous_forgery_protection
  end

  test "a fresh password form authenticates with its real CSRF token and cookie" do
    token = sign_in_form_token
    before_count = @user.sign_in_count

    post user_session_path, params: login_params(token: token)

    assert_redirected_to finance_dashboard_path
    assert_equal before_count + 1, @user.reload.sign_in_count
    follow_redirect!
    assert_response :success
    assert_select "#dashboard-balance"
  end

  test "a missing CSRF token is rejected before valid credentials authenticate the user" do
    sign_in_form_token
    before_authentication = authentication_state

    post user_session_path, params: login_params

    assert_rejected_sign_in(self)
    assert_equal before_authentication, authentication_state
    get finance_dashboard_path
    assert_redirected_to new_user_session_path
  end

  test "an invalid CSRF token is rejected before valid credentials authenticate the user" do
    sign_in_form_token
    before_authentication = authentication_state

    post user_session_path, params: login_params(token: "invalid-token-from-a-stale-page")

    assert_rejected_sign_in(self)
    assert_equal before_authentication, authentication_state
    get finance_dashboard_path
    assert_redirected_to new_user_session_path
  end

  test "a token from another browser is rejected and a fresh form can then sign in" do
    original_browser_token = sign_in_form_token
    other_browser = open_session
    sign_in_form_token(other_browser)
    before_authentication = authentication_state

    other_browser.post user_session_path, params: login_params(token: original_browser_token)

    assert_rejected_sign_in(other_browser)
    assert_equal before_authentication, authentication_state
    other_browser.get finance_dashboard_path
    assert_equal new_user_session_path, URI.parse(other_browser.response.location).path

    fresh_token = sign_in_form_token(other_browser)
    refute_includes other_browser.response.body, PASSWORD
    other_browser.post user_session_path, params: login_params(token: fresh_token)

    assert_includes [302, 303], other_browser.response.status
    assert_equal finance_dashboard_path, URI.parse(other_browser.response.location).path
    assert_equal before_authentication.fetch("sign_in_count") + 1, @user.reload.sign_in_count
    other_browser.get finance_dashboard_path
    assert_equal 200, other_browser.response.status
  end

  test "a valid form token does not authenticate an incorrect password" do
    token = sign_in_form_token
    before_count = @user.sign_in_count

    post user_session_path, params: login_params(token: token, password: "incorrect-password")

    assert_equal before_count, @user.reload.sign_in_count
    get finance_dashboard_path
    assert_redirected_to new_user_session_path
  end

  test "rejecting an invalid token does not sign out an already authenticated browser" do
    token = sign_in_form_token
    post user_session_path, params: login_params(token: token)
    assert_redirected_to finance_dashboard_path
    before_authentication = authentication_state

    post user_session_path, params: login_params(token: "invalid-token")

    assert_rejected_sign_in(self)
    assert_equal before_authentication, authentication_state
    get finance_dashboard_path
    assert_response :success
  end

  test "Google linking can finish with a genuine password form while CSRF is enabled" do
    previous_google_environment = ENV.values_at("GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET")
    previous_test_mode = OmniAuth.config.test_mode
    previous_mock_auth = OmniAuth.config.mock_auth.dup
    ENV["GOOGLE_CLIENT_ID"] = "billie-csrf-test.apps.googleusercontent.com"
    ENV["GOOGLE_CLIENT_SECRET"] = "test-csrf-google-secret"
    OmniAuth.config.test_mode = true
    OmniAuth.config.mock_auth[:google_oauth2] = OmniAuth::AuthHash.new(
      provider: "google_oauth2", uid: "csrf-google-subject",
      info: {email: @user.email, first_name: "Alex", last_name: "River"},
      extra: {id_info: {sub: "csrf-google-subject", email: @user.email, email_verified: true}}
    )

    get user_google_oauth2_omniauth_callback_path
    assert_redirected_to new_user_session_path
    assert_nil @user.reload.google_uid
    token = sign_in_form_token
    post user_session_path, params: login_params(token: token)

    assert_redirected_to finance_dashboard_path
    assert_equal "csrf-google-subject", @user.reload.google_uid
    follow_redirect!
    assert_response :success
  ensure
    OmniAuth.config.test_mode = previous_test_mode
    OmniAuth.config.mock_auth = previous_mock_auth
    %w[GOOGLE_CLIENT_ID GOOGLE_CLIENT_SECRET].zip(previous_google_environment).each do |name, value|
      value.nil? ? ENV.delete(name) : ENV[name] = value
    end
  end

  private

  def sign_in_form_token(browser = self)
    browser.get new_user_session_path
    assert_equal 200, browser.response.status
    document = Nokogiri::HTML(browser.response.body)
    field = document.at_css("form[action='#{user_session_path}'] input[name='authenticity_token']")
    assert field, "The password form must contain its own CSRF token"
    assert field["value"].present?
    field["value"]
  end

  def login_params(token: nil, password: PASSWORD)
    params = {user: {email: @user.email, password: password, remember_me: "0"}}
    params[:authenticity_token] = token if token
    params
  end

  def authentication_state
    @user.reload.attributes.slice("sign_in_count", "current_sign_in_at", "last_sign_in_at", "failed_attempts")
  end

  def assert_rejected_sign_in(browser)
    assert_equal 303, browser.response.status
    assert_equal new_user_session_path, URI.parse(browser.response.location).path
    refute_includes browser.response.location, PASSWORD
  end
end
