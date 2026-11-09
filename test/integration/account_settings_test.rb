require "test_helper"

class AccountSettingsTest < ActionDispatch::IntegrationTest
  include Devise::Test::IntegrationHelpers

  PASSWORD = "Gr33nCloud!Rain&2026"
  NEW_PASSWORD = "Bl8eSky!Snow&2027"

  setup do
    @user = create(:onboarded_user, password: PASSWORD, password_confirmation: PASSWORD, usage_region: "US", first_name: nil, last_name: nil)
  end

  test "sign up asks for an optional nickname instead of a legal name" do
    get new_user_registration_path
    assert_response :success
    assert_select "input[name='user[first_name]']", count: 0
    assert_select "input[name='user[last_name]']", count: 0
    assert_select "input[name='user[nickname]']:not([required])"

    assert_difference "User.count", 1 do
      post user_registration_path, params: {user: {email: "nickname-signup@example.com", nickname: "Rainy", usage_region: "US",
                                                   first_name: "Legal", last_name: "Name", password: PASSWORD, password_confirmation: PASSWORD}}
    end
    user = User.find_by!(email: "nickname-signup@example.com")
    assert_equal "Rainy", user.nickname
    assert_nil user.first_name
    assert_nil user.last_name
  end

  test "the privacy promise lives on the home page, not inside the app" do
    {"en" => "Billie protects your privacy — just a nickname, no legal name", "zh-CN" => "Billie保护个人信息，不用留真实姓名"}.each do |locale, promise|
      get billie_home_path, params: {locale: locale}
      assert_response :success
      assert_select ".bw-hero-details span", text: promise
    end
    sign_in @user
    get finance_settings_path, params: {locale: "en"}
    assert_select "#settings-profile p", count: 0
    refute_includes response.body, "legal name"
  end

  test "settings page offers nickname, password and searchable region sections" do
    sign_in @user
    get finance_settings_path
    assert_response :success
    assert_select "#settings-profile input[name='user[nickname]']"
    assert_select "#settings-password input[name='user[current_password]'][required]"
    assert_select "#settings-password input[name='user[password]'][required]"
    assert_select "#settings-region [data-region-search] input[type='search'][aria-controls='user_usage_region']"
    assert_select "#settings-region select#user_usage_region option[value='JP'][data-search*='Japan'][data-search*='JP']"
    assert_select "script[src='/billie.js']"
    # A saved region wins over the Global Citizen default.
    assert_select "select#user_usage_region option[selected]", count: 1
    assert_select "select#user_usage_region option[value='US'][selected]"
  end

  test "region search terms include the English name in every language" do
    sign_in @user
    get finance_settings_path, params: {locale: "zh-CN"}
    assert_select "select#user_usage_region option[value='JP'][data-search*='日本'][data-search*='Japan']"
    assert_select "select#user_usage_region option[value='GB'][data-search*='uk']"
  end

  test "nickname can be changed and shown in the sidebar" do
    sign_in @user
    patch nickname_finance_settings_path, params: {user: {nickname: " Billie Fan "}}
    assert_redirected_to finance_settings_path
    assert_equal "Billie Fan", @user.reload.nickname
    follow_redirect!
    assert_select ".bw-user strong", text: "Billie Fan"

    patch nickname_finance_settings_path, params: {user: {nickname: "x" * 41}}
    assert_response :unprocessable_entity
    assert_select "#settings-profile [role='alert']"
    assert_equal "Billie Fan", @user.reload.nickname

    patch nickname_finance_settings_path, params: {user: {nickname: "", email: "hijack@example.com", usage_region: "DE"}}
    assert_redirected_to finance_settings_path
    @user.reload
    assert_nil @user.nickname
    assert_equal "US", @user.usage_region
    refute_equal "hijack@example.com", @user.email
  end

  test "changing the password requires the current password and keeps the user signed in" do
    sign_in @user
    patch password_finance_settings_path, params: {user: {current_password: "wrong-password", password: NEW_PASSWORD, password_confirmation: NEW_PASSWORD}}
    assert_response :unprocessable_entity
    assert_select "#settings-password [role='alert']"
    assert @user.reload.valid_password?(PASSWORD)

    patch password_finance_settings_path, params: {user: {current_password: PASSWORD, password: NEW_PASSWORD, password_confirmation: "different"}}
    assert_response :unprocessable_entity
    assert @user.reload.valid_password?(PASSWORD)

    patch password_finance_settings_path, params: {user: {current_password: PASSWORD, password: "", password_confirmation: ""}}
    assert_response :unprocessable_entity
    assert @user.reload.valid_password?(PASSWORD)

    patch password_finance_settings_path, params: {user: {current_password: PASSWORD, password: NEW_PASSWORD, password_confirmation: NEW_PASSWORD}}
    assert_redirected_to finance_settings_path
    assert @user.reload.valid_password?(NEW_PASSWORD)
    get finance_dashboard_path
    assert_response :success

    delete destroy_user_session_path
    post user_session_path, params: {user: {email: @user.email, password: NEW_PASSWORD}}
    assert_redirected_to finance_dashboard_path
  end

  test "Google accounts can request a link to choose their own password" do
    get finance_settings_path
    assert_redirected_to new_user_session_path
    post password_reset_finance_settings_path
    assert_redirected_to new_user_session_path

    sign_in @user
    get finance_settings_path
    assert_select "#settings-password form[action='#{password_reset_finance_settings_path}']", count: 0

    @user.update!(google_uid: "google-settings-subject")
    get finance_settings_path
    assert_select "#settings-password form[action='#{password_reset_finance_settings_path}']"
    assert_emails 1 do
      post password_reset_finance_settings_path
    end
    assert_redirected_to finance_settings_path
    assert @user.reload.reset_password_token.present?
  end

  test "settings actions require sign in" do
    patch nickname_finance_settings_path, params: {user: {nickname: "Nope"}}
    assert_redirected_to new_user_session_path
    patch password_finance_settings_path, params: {user: {current_password: PASSWORD, password: NEW_PASSWORD, password_confirmation: NEW_PASSWORD}}
    assert_redirected_to new_user_session_path
    assert @user.reload.valid_password?(PASSWORD)
  end
end
