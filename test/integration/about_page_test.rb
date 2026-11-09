require "test_helper"

class AboutPageTest < ActionDispatch::IntegrationTest
  include Devise::Test::IntegrationHelpers

  test "about us is public, linked beside Features, and localized" do
    get billie_home_path, params: {locale: "en"}
    assert_select ".bw-public-links a", text: "How it works", count: 0
    assert_select ".bw-public-links a[href='#{billie_features_path}']", text: "Features & Membership"
    assert_select ".bw-public-links a[href='#{billie_about_path}']", text: "About us"
    assert_select ".bw-public-links a[href='#{billie_about_path}'] + a[data-dialog-open='support-dialog'][href='#{billie_features_path(anchor: "support")}']", text: "Support us"

    %w[en zh-CN zh-TW ja ko es].each do |locale|
      get billie_about_path, params: {locale: locale}
      assert_response :success
      assert_select "html[lang='#{locale}']"
      assert_select "h1", text: I18n.t("billie.about.heading", locale: locale)
      assert_select ".bw-public-links a[aria-current='page']", text: I18n.t("billie.layout.about_us", locale: locale)
      assert_select ".bw-feature-card", count: 3
      assert_includes response.body, ERB::Util.html_escape(I18n.t("billie.about.privacy_body", locale: locale))
      assert_no_match(/translation_missing|Translation missing/, response.body)
    end
    assert_select "a[href='#{new_user_registration_path}']"
  end

  test "signed-in visitors are pointed to their dashboard" do
    sign_in create(:onboarded_user, usage_region: "US")
    get billie_about_path, params: {locale: "en"}
    assert_response :success
    assert_select ".bw-marketing-cta a[href='#{finance_dashboard_path}']"
  end
end
