require "test_helper"

class UserUsageRegionIntegrationTest < ActionDispatch::IntegrationTest
  include Devise::Test::IntegrationHelpers

  test "registration requires a fixed region selection and saves its code" do
    get new_user_registration_path
    assert_response :success
    assert_select "select#user_usage_region[name='user[usage_region]']" do
      assert_select "option[value='']", count: 0
      assert_select "option[selected]", count: 1
      assert_select "option[value='XG'][selected]", text: "Global Citizen"
      assert_select "option[value='US']"
      assert_select "option[value='CN']", text: "Mainland China"
      assert_select "option[value='JP']"
    end
    assert_select "input[name='user[usage_region]']", count: 0

    assert_difference "User.count", 1 do
      post user_registration_path, params: registration_params("region-signup@example.com", usage_region: "CA")
    end
    assert_redirected_to finance_dashboard_path
    user = User.find_by!(email: "region-signup@example.com")
    assert_equal "CA", user.usage_region
    assert_not user.usage_region_pending?
  end

  test "registration rejects missing and empty regions" do
    [registration_params("missing-region-signup@example.com"),
      registration_params("empty-region-signup@example.com", usage_region: "")].each do |parameters|
      assert_no_difference "User.count" do
        post user_registration_path, params: parameters
      end
      assert_response :unprocessable_entity
      assert_select "[role='alert']", text: /region/i
      assert_select "select#user_usage_region"
    end
  end

  test "registration rejects a region outside the list instead of ignoring it" do
    assert_no_difference "User.count" do
      post user_registration_path, params: registration_params("invented-region@example.com", usage_region: "Atlantis")
    end
    assert_response :unprocessable_entity
    assert_select "[role='alert']", text: /region/i
    assert_select "select#user_usage_region"
    assert_nil User.find_by(email: "invented-region@example.com")
  end

  test "settings require authentication for both viewing and updating the region" do
    get finance_settings_path
    assert_redirected_to new_user_session_path
    patch finance_settings_path, params: {user: {usage_region: "US"}}
    assert_redirected_to new_user_session_path
  end

  test "Global Citizen can be selected at signup and saved by an existing user" do
    get new_user_registration_path
    assert_select "select#user_usage_region option[value='XG']", text: "Global Citizen"
    assert_difference "User.count", 1 do
      post user_registration_path, params: registration_params("global-citizen@example.com", usage_region: "XG")
    end
    assert_redirected_to finance_dashboard_path
    user = User.find_by!(email: "global-citizen@example.com")
    assert_equal "XG", user.usage_region

    patch finance_settings_path, params: {user: {usage_region: "JP"}}
    assert_redirected_to finance_settings_path
    patch finance_settings_path, params: {user: {usage_region: "xg"}}
    assert_redirected_to finance_settings_path
    assert_equal "XG", user.reload.usage_region
    get finance_settings_path
    assert_select "select#user_usage_region option[value='XG'][selected]", text: "Global Citizen"
    assert_select "select#user_usage_region option" do |options|
      assert_equal "XG", options.find { |option| option["value"].present? }["value"]
    end
  end

  test "legacy users must complete region selection before finance activity" do
    user = create(:user)
    user.update_columns(usage_region: nil, usage_region_pending: true)
    sign_in user

    [finance_dashboard_path, finance_transactions_path, finance_forecast_path, finance_insights_path, finance_tax_preparation_path, finance_statements_path].each do |path|
      get path
      assert_redirected_to finance_settings_path
    end
    get finance_settings_path
    assert_response :success
    # Global Citizen is preselected, but nothing is saved until the person submits.
    assert_select "select#user_usage_region option[value='XG'][selected]"
    assert_nil user.reload.usage_region

    patch finance_settings_path, params: {user: {usage_region: "jp"}}
    assert_redirected_to finance_settings_path
    assert_equal "JP", user.reload.usage_region
    assert_not user.usage_region_pending?
    get finance_dashboard_path
    assert_response :success
  end

  test "users can change their selected region but cannot clear it" do
    user = create(:user, usage_region: "JP")
    sign_in user
    get finance_settings_path
    assert_response :success
    assert_select "select#user_usage_region option[value='JP'][selected]"

    patch finance_settings_path, params: {user: {usage_region: "KR"}}
    assert_redirected_to finance_settings_path
    assert_equal "KR", user.reload.usage_region
    patch finance_settings_path, params: {user: {usage_region: ""}}
    assert_response :unprocessable_entity
    assert_select "[role='alert']", text: /region/i
    assert_equal "KR", user.reload.usage_region
  end

  test "legacy region completion rejects missing and malformed region selections" do
    user = create(:user)
    user.update_columns(usage_region: nil, usage_region_pending: true)
    sign_in user

    [{unrelated: "value"}, {usage_region: []}, {usage_region: {code: "US"}}].each do |attributes|
      patch finance_settings_path, params: {user: attributes}
      assert_response :unprocessable_entity
      assert_select "[role='alert']", text: /region/i
      assert_nil user.reload.usage_region
      assert user.usage_region_pending?
    end
  end

  test "settings reject invented regions and update only the signed in user region" do
    user = create(:user, usage_region: "US")
    other = create(:user, usage_region: "CA")
    original_email = user.email
    sign_in user

    patch finance_settings_path, params: {user: {usage_region: "XX"}}
    assert_response :unprocessable_entity
    assert_select "[role='alert']", text: /region/i
    assert_equal "US", user.reload.usage_region

    patch finance_settings_path, params: {user_id: other.id,
      user: {id: other.id, usage_region: "DE", usage_region_pending: true, email: "changed-region@example.com", first_name: "Changed"}}
    assert_redirected_to finance_settings_path
    assert_equal "DE", user.reload.usage_region
    assert_not user.usage_region_pending?
    assert_equal original_email, user.email
    assert_nil user.first_name
    assert_equal "CA", other.reload.usage_region
  end

  test "account profile editing uses the same required region list" do
    user = create(:onboarded_user, usage_region: "AU")
    sign_in user
    get edit_account_user_path(user)
    assert_response :success
    assert_select "select#user_usage_region[name='user[usage_region]']"
    assert_select "select#user_usage_region option[value='AU'][selected]"

    patch account_user_path(user), params: {user: {usage_region: "FR"}}
    assert_redirected_to edit_account_user_path(user)
    assert_equal "FR", user.reload.usage_region
  end

  test "region labels, including Mainland China and Global Citizen, are localized in all six languages" do
    user = create(:user, usage_region: "JP")
    sign_in user
    codes = nil
    {"en" => ["Japan", "Usage region", "Mainland China", "Global Citizen"],
     "zh-CN" => ["日本", "使用地区", "中国大陆", "世界公民"], "zh-TW" => ["日本", "使用地區", "中國大陸", "世界公民"],
     "ja" => ["日本", "利用する地域", "中国本土", "地球市民"], "ko" => ["일본", "사용 지역", "중국 본토", "세계 시민"],
     "es" => ["Japón", "Región de uso", "China continental", "Ciudadanía global"]}.each do |locale, (japan, label, mainland, global)|
      get finance_settings_path, params: {locale: locale}
      assert_response :success
      assert_select "html[lang='#{locale}']"
      assert_select "label[for='user_usage_region']", text: label
      assert_select "select#user_usage_region option[value='JP']", text: japan
      assert_select "select#user_usage_region option[value='CN']", text: mainland
      assert_select "select#user_usage_region option[value='XG']", text: global
      # The English names stay searchable in every language.
      assert_select "select#user_usage_region option[value='CN'][data-search*='Mainland China']"
      assert_select "select#user_usage_region option[value='XG'][data-search*='Global Citizen']"
      assert_select "select#user_usage_region option[value='HK']"
      assert_select "select#user_usage_region option[value='TW']"
      assert_select "input[name='user[usage_region]']", count: 0
      assert_select "select#user_usage_region option" do |options|
        current_codes = options.map { |option| option["value"] }.reject(&:blank?).sort
        assert_equal UsageRegion::CODES.sort, current_codes
        codes ? assert_equal(codes, current_codes) : codes = current_codes
      end
    end
    assert_equal "JP", user.reload.usage_region
  end

  private

  def registration_params(email, **attributes)
    {user: {email: email,
      password: "Gr33nCloud!Rain&2026", password_confirmation: "Gr33nCloud!Rain&2026"}.merge(attributes)}
  end
end
