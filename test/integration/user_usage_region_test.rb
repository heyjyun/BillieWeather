require "test_helper"

class UserUsageRegionIntegrationTest < ActionDispatch::IntegrationTest
  include Devise::Test::IntegrationHelpers

  test "registration offers an optional fixed country list and saves the selected code" do
    get new_user_registration_path
    assert_response :success
    assert_select "select#user_usage_region[name='user[usage_region]']:not([required])" do
      assert_select "option[value='']"
      assert_select "option[value='US']"
      assert_select "option[value='JP']"
    end
    assert_select "input[name='user[usage_region]']", count: 0

    assert_difference "User.count", 1 do
      post user_registration_path, params: registration_params("region-signup@example.com", usage_region: "CA")
    end
    assert_redirected_to finance_dashboard_path
    assert_equal "CA", User.find_by!(email: "region-signup@example.com").usage_region
  end

  test "registration without a country remains available" do
    assert_difference "User.count", 1 do
      post user_registration_path, params: registration_params("optional-region-signup@example.com")
    end
    assert_redirected_to finance_dashboard_path
    assert_nil User.find_by!(email: "optional-region-signup@example.com").usage_region
  end

  test "registration rejects a country outside the list instead of ignoring it" do
    assert_no_difference "User.count" do
      post user_registration_path, params: registration_params("invented-region@example.com", usage_region: "Atlantis")
    end
    assert_response :unprocessable_entity
    assert_select "[role='alert']", text: /region|country/i
    assert_select "select#user_usage_region"
    assert_nil User.find_by(email: "invented-region@example.com")
  end

  test "settings require authentication for both viewing and updating the region" do
    get finance_settings_path
    assert_redirected_to new_user_session_path
    patch finance_settings_path, params: {user: {usage_region: "US"}}
    assert_redirected_to new_user_session_path
  end

  test "existing users can select change and clear their usage region" do
    user = create(:user)
    sign_in user
    get finance_settings_path
    assert_response :success
    assert_select "select#user_usage_region option[value='']"

    patch finance_settings_path, params: {user: {usage_region: "jp"}}
    assert_redirected_to finance_settings_path
    assert_equal "JP", user.reload.usage_region
    follow_redirect!
    assert_select "select#user_usage_region option[value='JP'][selected]"

    patch finance_settings_path, params: {user: {usage_region: "KR"}}
    assert_redirected_to finance_settings_path
    assert_equal "KR", user.reload.usage_region
    patch finance_settings_path, params: {user: {usage_region: ""}}
    assert_redirected_to finance_settings_path
    assert_nil user.reload.usage_region
  end

  test "settings reject invented countries and update only the signed in user region" do
    user = create(:user, usage_region: "US")
    other = create(:user, usage_region: "CA")
    original_email = user.email
    sign_in user

    patch finance_settings_path, params: {user: {usage_region: "XX"}}
    assert_response :unprocessable_entity
    assert_select "[role='alert']", text: /region|country/i
    assert_equal "US", user.reload.usage_region

    patch finance_settings_path, params: {user_id: other.id,
      user: {id: other.id, usage_region: "DE", email: "changed-region@example.com", first_name: "Changed"}}
    assert_redirected_to finance_settings_path
    assert_equal "DE", user.reload.usage_region
    assert_equal original_email, user.email
    assert_nil user.first_name
    assert_equal "CA", other.reload.usage_region
  end

  test "account profile editing uses the same optional country list" do
    user = create(:onboarded_user, usage_region: "AU")
    sign_in user
    get edit_account_user_path(user)
    assert_response :success
    assert_select "select#user_usage_region[name='user[usage_region]']:not([required])"
    assert_select "select#user_usage_region option[value='AU'][selected]"

    patch account_user_path(user), params: {user: {usage_region: "FR"}}
    assert_redirected_to edit_account_user_path(user)
    assert_equal "FR", user.reload.usage_region
  end

  test "country options are localized in all four languages and store identical codes" do
    user = create(:user)
    sign_in user
    codes = nil
    {"en" => "Japan", "zh-CN" => "日本", "ja" => "日本", "ko" => "일본"}.each do |locale, japan|
      get finance_settings_path, params: {locale: locale}
      assert_response :success
      assert_select "html[lang='#{locale}']"
      assert_select "select#user_usage_region option[value='JP']", text: japan
      assert_select "input[name='user[usage_region]']", count: 0
      assert_select "select#user_usage_region option" do |options|
        current_codes = options.map { |option| option["value"] }.reject(&:blank?).sort
        assert_equal UsageRegion::CODES.sort, current_codes
        codes ? assert_equal(codes, current_codes) : codes = current_codes
      end
    end
    assert_nil user.reload.usage_region
  end

  private

  def registration_params(email, **attributes)
    {user: {first_name: "Alex", last_name: "River", email: email,
      password: "Gr33nCloud!Rain&2026", password_confirmation: "Gr33nCloud!Rain&2026"}.merge(attributes)}
  end
end
