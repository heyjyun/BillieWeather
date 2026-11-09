require "test_helper"

class GoogleUsageRegionTest < ActionDispatch::IntegrationTest
  include Devise::Test::IntegrationHelpers

  setup do
    @google_environment = ENV.values_at("GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET")
    ENV["GOOGLE_CLIENT_ID"] = "billie-region-test.apps.googleusercontent.com"
    ENV["GOOGLE_CLIENT_SECRET"] = "test-region-google-secret"
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

  test "new Google identity waits for a required region without saving a partial account" do
    assert_no_difference ["User.count", "Team.count", "Membership.count"] do
      get user_google_oauth2_omniauth_callback_path
    end
    assert_redirected_to new_google_region_path
    follow_redirect!
    assert_response :success
    assert_select "select#user_usage_region[name='user[usage_region]'][required]"
    assert_select "option[value='CN']", text: "Mainland China"
    assert_select "input[name='user[email]'], input[name='uid'], input[name='auth']", count: 0
    refute_includes response.body, "private-google-token"
    refute_includes response.body, "private-google-refresh"
    assert_includes response.headers["Cache-Control"], "no-store"
  end

  test "verified Google signup creates an account only with a valid selected region and ignores submitted identities" do
    get user_google_oauth2_omniauth_callback_path
    assert_difference ["User.count", "Team.count", "Membership.count"], 1 do
      post google_region_path, params: {user: {usage_region: "jp", email: "forged@example.com", google_uid: "forged"},
        uid: "forged", email: "forged@example.com"}
    end
    assert_redirected_to finance_dashboard_path
    user = User.find_by!(google_uid: "region-google-subject")
    assert_equal "JP", user.usage_region
    assert_equal "region-google@example.com", user.email
    assert_equal "Alex", user.first_name
    assert_equal 1, user.teams.count
    refute User.exists?(email: "forged@example.com")
    refute_includes user.attributes.values.compact.map(&:to_s).join(" "), "private-google-token"

    delete destroy_user_session_path
    assert_no_difference "User.count" do
      post google_region_path, params: {user: {usage_region: "KR"}}
    end
    assert_redirected_to new_user_session_path
  end

  test "blank and invented regions cannot complete Google signup and may be corrected" do
    get user_google_oauth2_omniauth_callback_path
    ["", "XX", "Atlantis"].each do |region|
      assert_no_difference ["User.count", "Team.count", "Membership.count"] do
        post google_region_path, params: {user: {usage_region: region}}
      end
      assert_response :unprocessable_entity
      assert_select "[role='alert']"
      assert_select "select#user_usage_region[required]"
    end
    assert_difference "User.count", 1 do
      post google_region_path, params: {user: {usage_region: "HK"}}
    end
    assert_equal "HK", User.find_by!(google_uid: "region-google-subject").usage_region
  end

  test "expired and missing verified identities cannot complete Google signup" do
    assert_no_difference "User.count" do
      post google_region_path, params: {user: {usage_region: "US"}, auth: google_auth.to_h}
    end
    assert_redirected_to new_user_session_path

    get user_google_oauth2_omniauth_callback_path
    travel 11.minutes do
      assert_no_difference "User.count" do
        post google_region_path, params: {user: {usage_region: "US"}}
      end
      assert_redirected_to new_user_session_path
      assert_match(/expired/i, flash[:alert])
    end
  end

  test "completion rechecks email ownership instead of merging a newly created password account" do
    get user_google_oauth2_omniauth_callback_path
    password_user = create(:user, email: "region-google@example.com", usage_region: "CA")
    assert_no_difference ["User.count", "Team.count", "Membership.count"] do
      post google_region_path, params: {user: {usage_region: "TW"}}
    end
    assert_redirected_to new_user_session_path
    assert_nil password_user.reload.google_uid
    assert_equal "CA", password_user.usage_region
  end

  test "completion rechecks whether Google signup is still enabled" do
    get user_google_oauth2_omniauth_callback_path
    previous_keys = ENV["INVITATION_KEYS"]
    ENV["INVITATION_KEYS"] = "region-private-invitation-key"
    assert_no_difference ["User.count", "Team.count", "Membership.count"] do
      post google_region_path, params: {user: {usage_region: "US"}}
    end
    assert_redirected_to new_user_session_path
  ensure
    previous_keys.nil? ? ENV.delete("INVITATION_KEYS") : ENV["INVITATION_KEYS"] = previous_keys
  end

  test "deferred Google signup accepts its pending invitation without creating an extra workspace" do
    inviter = create(:onboarded_user)
    team = inviter.current_team
    email = "region-google@example.com"
    membership = team.memberships.build(user_email: email)
    invitation = Invitation.create!(team: team, from_membership: inviter.memberships.first,
      email: email, membership: membership)

    get accept_account_invitation_path(invitation.uuid)
    assert_redirected_to new_user_registration_path(invitation_uuid: invitation.uuid)
    follow_redirect!
    assert_response :success
    assert_no_difference ["User.count", "Team.count", "Membership.count"] do
      get user_google_oauth2_omniauth_callback_path
    end
    assert_redirected_to new_google_region_path

    assert_difference "User.count", 1 do
      assert_no_difference ["Team.count", "Membership.count"] do
        post google_region_path, params: {user: {usage_region: "KR"}}
      end
    end
    user = User.find_by!(google_uid: "region-google-subject")
    assert_equal "KR", user.usage_region
    assert_equal user, membership.reload.user
    assert_equal team, user.current_team
    assert_equal [team.id], user.team_ids
    assert_not Invitation.exists?(invitation.id)
    assert_redirected_to accept_account_invitation_path(invitation.uuid)
    follow_redirect!
    assert_redirected_to account_dashboard_path
  end

  test "a linked legacy Google account must choose a region in settings before using the app" do
    user = create(:onboarded_user, email: "region-google@example.com", google_uid: "region-google-subject")
    user.update_columns(usage_region: nil, usage_region_pending: true)
    original_team_id = user.current_team_id
    assert_no_difference ["User.count", "Team.count", "Membership.count"] do
      get user_google_oauth2_omniauth_callback_path
    end
    assert_redirected_to finance_settings_path
    assert_nil user.reload.usage_region
    follow_redirect!
    assert_response :success
    assert_select "select#user_usage_region[required]"
    get finance_dashboard_path
    assert_redirected_to finance_settings_path

    patch finance_settings_path, params: {user: {usage_region: "TW"}}
    assert_redirected_to finance_settings_path
    assert_equal "TW", user.reload.usage_region
    assert_not user.usage_region_pending?
    assert_equal original_team_id, user.current_team_id
    get finance_dashboard_path
    assert_response :success
  end

  test "an invitation for another email requires explicit confirmation after Google signup" do
    inviter = create(:onboarded_user)
    invited_team = inviter.current_team
    membership = invited_team.memberships.build(user_email: "another-invitee@example.com")
    invitation = Invitation.create!(team: invited_team, from_membership: inviter.memberships.first,
      email: "another-invitee@example.com", membership: membership)

    get accept_account_invitation_path(invitation.uuid)
    follow_redirect!
    get user_google_oauth2_omniauth_callback_path
    assert_redirected_to new_google_region_path
    assert_difference ["User.count", "Team.count", "Membership.count"], 1 do
      post google_region_path, params: {user: {usage_region: "JP"}}
    end
    user = User.find_by!(google_uid: "region-google-subject")
    assert_equal "region-google@example.com", user.email
    assert_equal "JP", user.usage_region
    assert_nil membership.reload.user
    assert Invitation.exists?(invitation.id)
    assert_not_includes user.team_ids, invited_team.id
    assert_equal 1, user.teams.count
    assert_equal user.teams.first, user.current_team
    assert_redirected_to accept_account_invitation_path(invitation.uuid)
    follow_redirect!
    assert_redirected_to account_invitation_path(invitation.uuid)
    assert_nil membership.reload.user
  end

  test "Google region completion requires its browser CSRF token" do
    original = ActionController::Base.allow_forgery_protection
    ActionController::Base.allow_forgery_protection = true
    get user_google_oauth2_omniauth_callback_path
    follow_redirect!
    token = css_select("meta[name='csrf-token']").first["content"]
    assert_no_difference "User.count" do
      post google_region_path, params: {user: {usage_region: "US"}}
    end
    assert_response :unprocessable_entity
    assert_difference "User.count", 1 do
      post google_region_path, params: {authenticity_token: token, user: {usage_region: "US"}}
    end
    assert_redirected_to finance_dashboard_path
  ensure
    ActionController::Base.allow_forgery_protection = original
  end

  private

  def google_auth
    OmniAuth::AuthHash.new(provider: "google_oauth2", uid: "region-google-subject",
      info: {email: "region-google@example.com", first_name: "Alex", last_name: "River"},
      credentials: {token: "private-google-token", refresh_token: "private-google-refresh"},
      extra: {id_info: {sub: "region-google-subject", email: "region-google@example.com", email_verified: true}})
  end
end
