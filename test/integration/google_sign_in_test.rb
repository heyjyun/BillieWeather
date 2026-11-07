require "test_helper"
require "uri"
require_relative "../support/billie_method_stub"

class GoogleSignInTest < ActionDispatch::IntegrationTest
  include Devise::Test::IntegrationHelpers
  include BillieMethodStub

  PASSWORD = "G00gle!ExistingAccount&2026"

  setup do
    @google_environment = ENV.values_at("GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET")
    ENV["GOOGLE_CLIENT_ID"] = "billie-test.apps.googleusercontent.com"
    ENV["GOOGLE_CLIENT_SECRET"] = "test-google-client-secret"
    @previous_test_mode = OmniAuth.config.test_mode
    @previous_mock_auth = OmniAuth.config.mock_auth.dup
    OmniAuth.config.test_mode = true
    OmniAuth.config.mock_auth[:google_oauth2] = google_auth
  end

  teardown do
    OmniAuth.config.test_mode = @previous_test_mode
    OmniAuth.config.mock_auth = @previous_mock_auth
    %w[GOOGLE_CLIENT_ID GOOGLE_CLIENT_SECRET].zip(@google_environment).each do |name, value|
      value.nil? ? ENV.delete(name) : ENV[name] = value
    end
  end

  test "registration and login expose a separate POST Google form when configured" do
    [new_user_registration_path, new_user_session_path].each do |path|
      get path
      assert_response :success
      assert_select "form[action='#{user_google_oauth2_omniauth_authorize_path}'][method='post']" do
        assert_select "button", text: /Continue with Google/
        assert_select "input[name='user[email]'], input[name='user[password]']", count: 0
      end
      assert_select "input[name='user[email]']"
      assert_select "input[name='user[password]']"
    end
  end

  test "missing configuration leaves email usable and never advertises a working Google form" do
    ENV.delete("GOOGLE_CLIENT_SECRET")
    [new_user_registration_path, new_user_session_path].each do |path|
      get path
      assert_response :success
      assert_select "button[disabled]", text: /Continue with Google/
      assert_select "input[name='user[email]']"
      assert_select "form[action='#{user_google_oauth2_omniauth_authorize_path}']", count: 0
      refute_includes response.body, "GOOGLE_CLIENT_SECRET"
      refute_includes response.body, "GOOGLE_CLIENT_ID"
    end
  end

  test "missing configuration rejects direct Google callbacks without creating an account" do
    ENV.delete("GOOGLE_CLIENT_SECRET")
    # Exercise the production middleware path: mock mode does not rescue setup errors.
    OmniAuth.config.test_mode = false
    stub_method(Net::HTTP, :new, ->(*) { flunk "An unconfigured callback must not contact Google" }) do
      assert_no_difference ["User.count", "Team.count", "Membership.count"] do
        get user_google_oauth2_omniauth_callback_path, params: {code: "not-a-real-code", state: "not-a-real-state"}
      end
    end
    assert_includes [302, 303, 422], response.status
    get finance_dashboard_path
    assert_redirected_to new_user_session_path
  end

  test "invitation-only mode blocks Google signup but permits an already linked identity" do
    linked_user = existing_user(google_uid: "existing-linked-google-subject")
    previous_keys = ENV["INVITATION_KEYS"]
    ENV["INVITATION_KEYS"] = "private-test-invitation-key"
    assert_no_difference ["User.count", "Team.count", "Membership.count"] do
      google_callback
    end
    assert_redirected_to new_user_session_path
    get finance_dashboard_path
    assert_redirected_to new_user_session_path

    assert_no_difference ["User.count", "Team.count", "Membership.count"] do
      google_callback(google_auth(uid: linked_user.google_uid, email: linked_user.email))
    end
    assert_redirected_to finance_dashboard_path
  ensure
    previous_keys.nil? ? ENV.delete("INVITATION_KEYS") : ENV["INVITATION_KEYS"] = previous_keys
  end

  test "GET requests cannot initiate Google authentication" do
    OmniAuth.config.test_mode = false
    stub_method(Net::HTTP, :new, ->(*) { flunk "A GET initiation must not contact Google" }) do
      assert_no_difference "User.count" do
        get user_google_oauth2_omniauth_authorize_path
      end
    end
    assert_response :not_found
  end

  test "a verified new Google identity creates one user and a usable Bullet Train workspace" do
    assert_difference ["User.count", "Team.count", "Membership.count"], 1 do
      google_callback
    end
    assert_redirected_to finance_dashboard_path
    user = User.find_by!(google_uid: "google-subject-123")
    assert_equal "google-reader@example.com", user.email
    assert_equal "Alex", user.first_name
    assert_equal "River", user.last_name
    assert user.current_team
    assert_equal 1, user.teams.count
    assert user.encrypted_password.present?
    refute_includes user.attributes.values.compact.map(&:to_s).join(" "), "private-access-token"
    refute_includes user.attributes.values.compact.map(&:to_s).join(" "), "private-refresh-token"
    follow_redirect!
    assert_response :success
    assert Finance::Profile.exists?(user_id: user.id)
  end

  test "repeat Google login uses the UID and preserves names workspace and finance data" do
    user = existing_user(email: "saved@example.com", google_uid: "google-subject-123", first_name: "Saved", last_name: "Name")
    Finance::Profile.create!(user: user, current_balance: "777.77", balance_source: "manual")
    original_team = user.current_team_id
    # Google addresses can change. That must not replace the local identity or merge another user.
    google_auth_hash = google_auth(email: "changed@example.com")
    assert_no_difference ["User.count", "Team.count", "Membership.count", "Finance::Profile.count"] do
      google_callback(google_auth_hash)
    end
    assert_redirected_to finance_dashboard_path
    user.reload
    assert_equal "saved@example.com", user.email
    assert_equal "Saved", user.first_name
    assert_equal "Name", user.last_name
    assert_equal original_team, user.current_team_id
    assert_equal BigDecimal("777.77"), user.finance_profile.current_balance
    follow_redirect!
    assert_response :success
    assert_select "#dashboard-balance strong", text: "$777.77"
  end

  test "matching an existing email requires its password before connecting Google" do
    user = existing_user(email: "google-reader@example.com")
    original_team = user.current_team_id
    assert_no_difference ["User.count", "Team.count", "Membership.count"] do
      google_callback
    end
    assert_redirected_to new_user_session_path
    assert_nil user.reload.google_uid
    get finance_dashboard_path
    assert_redirected_to new_user_session_path

    post user_session_path, params: {user: {email: user.email, password: PASSWORD}}
    assert_redirected_to finance_dashboard_path
    assert_equal "google-subject-123", user.reload.google_uid
    assert_equal original_team, user.current_team_id

    delete destroy_user_session_path
    google_callback
    assert_redirected_to finance_dashboard_path
  end

  test "a failed password confirmation does not bind the pending Google identity" do
    user = existing_user(email: "google-reader@example.com")
    google_callback
    post user_session_path, params: {user: {email: user.email, password: "incorrect-password"}}
    assert_nil user.reload.google_uid
    get finance_dashboard_path
    assert_redirected_to new_user_session_path
  end

  test "an expired pending Google connection cannot be completed by a later password login" do
    user = existing_user(email: "google-reader@example.com")
    google_callback
    travel 11.minutes do
      post user_session_path, params: {user: {email: user.email, password: PASSWORD}}
      assert_redirected_to finance_dashboard_path
      assert_nil user.reload.google_uid
    end
  end

  test "logging into a different local account cannot claim a pending Google identity" do
    matching = existing_user(email: "google-reader@example.com")
    other = existing_user(email: "another-reader@example.com")
    google_callback
    post user_session_path, params: {user: {email: other.email, password: PASSWORD}}
    assert_redirected_to finance_dashboard_path
    assert_nil matching.reload.google_uid
    assert_nil other.reload.google_uid
  end

  test "locked accounts cannot bypass their lock through Google" do
    user = existing_user(google_uid: "google-subject-123")
    user.update!(locked_at: Time.current, failed_attempts: User.maximum_attempts)
    google_callback
    assert_redirected_to new_user_session_path
    get finance_dashboard_path
    assert_redirected_to new_user_session_path
    assert user.reload.access_locked?
  end

  test "Google login cannot bypass a local authentication code requirement" do
    user = existing_user(google_uid: "google-subject-123")
    user.update!(otp_required_for_login: true)
    google_callback
    assert_redirected_to new_user_session_path
    get finance_dashboard_path
    assert_redirected_to new_user_session_path
    assert user.reload.otp_required_for_login
  end

  test "unverified and mismatched Google claims never create accounts" do
    invalid_auths = [
      google_auth(verified: false),
      google_auth(verified: "false"),
      google_auth(subject: "a-different-subject"),
      google_auth(provider: "untrusted-provider"),
      google_auth(info_email: nil),
      google_auth(info_email: "a-different-address@example.com")
    ]
    invalid_auths.each do |auth|
      assert_no_difference ["User.count", "Team.count", "Membership.count"] do
        google_callback(auth)
      end
      assert_redirected_to new_user_session_path
      refute_includes flash.to_hash.values.join(" "), "private-access-token"
      get finance_dashboard_path
      assert_redirected_to new_user_session_path
    end
  end

  test "canceling Google authorization returns a generic message without provider secrets" do
    OmniAuth.config.mock_auth[:google_oauth2] = :access_denied
    assert_no_difference "User.count" do
      get user_google_oauth2_omniauth_callback_path
    end
    assert_redirected_to new_user_session_path
    assert flash[:alert].present?
    refute_includes flash.to_hash.values.join(" "), "test-google-client-secret"
    refute_includes flash.to_hash.values.join(" "), "private-access-token"
    refute_includes flash.to_hash.values.join(" "), "OmniAuth::"
  end

  test "real Google initiation requires CSRF and sends state PKCE and only identity scopes" do
    with_forgery_protection do
      OmniAuth.config.test_mode = false
      get new_user_session_path
      assert_response :success
      token = css_select("meta[name='csrf-token']").first["content"]
      stub_method(Net::HTTP, :new, ->(*) { flunk "Google initiation and rejected callbacks must not contact Google" }) do
        post user_google_oauth2_omniauth_authorize_path
        assert_response :unprocessable_entity

        post user_google_oauth2_omniauth_authorize_path, params: {authenticity_token: token}
        assert_response :redirect
        authorization_uri = URI.parse(response.location)
        assert_equal "accounts.google.com", authorization_uri.host
        params = URI.decode_www_form(authorization_uri.query).to_h
        assert params["state"].present?
        assert params["code_challenge"].present?
        assert_equal "S256", params["code_challenge_method"]
        assert_equal %w[email openid profile], params.fetch("scope").split(/[ ,]+/).sort
        assert_equal "online", params["access_type"]
        assert_equal user_google_oauth2_omniauth_callback_url, params["redirect_uri"]

        assert_no_difference "User.count" do
          get user_google_oauth2_omniauth_callback_path, params: {state: "wrong-state", code: "not-a-real-code"}
        end
        assert_redirected_to new_user_session_path
      end
    end
  end

  private

  def google_auth(uid: "google-subject-123", subject: uid, email: "google-reader@example.com", info_email: email, verified: true, provider: "google_oauth2")
    OmniAuth::AuthHash.new(
      provider: provider, uid: uid,
      info: {email: info_email, first_name: "Alex", last_name: "River", name: "Alex River"},
      credentials: {token: "private-access-token", refresh_token: "private-refresh-token"},
      extra: {id_info: {sub: subject, email: email, email_verified: verified}, raw_info: {sub: subject, email: email, email_verified: verified}}
    )
  end

  def google_callback(auth = google_auth)
    OmniAuth.config.mock_auth[:google_oauth2] = auth
    get user_google_oauth2_omniauth_callback_path
  end

  def existing_user(**attributes)
    user = create(:user, password: PASSWORD, password_confirmation: PASSWORD, **attributes)
    user.create_default_team
    user
  end

  def with_forgery_protection
    original = ActionController::Base.allow_forgery_protection
    ActionController::Base.allow_forgery_protection = true
    yield
  ensure
    ActionController::Base.allow_forgery_protection = original
  end
end
