require "application_system_test_case"

class OnboardingTimeZoneTest < ApplicationSystemTestCase
  setup do
    @user = create :onboarded_user, time_zone: "UTC"
    login_as(@user, scope: :user)
  end

  device_test "browser time zone is selected before the optional widget exists" do
    visit edit_account_onboarding_user_detail_path(@user)
    expected_time_zone = detected_time_zone
    page.execute_script <<~JS
      document.querySelector("#select2-user_time_zone-container")?.remove();
      document.querySelector("#user_time_zone").value = #{((expected_time_zone == "UTC") ? "Tokyo" : "UTC").to_json};
    JS

    assert_no_js_errors do
      page.execute_script("btSetUserTimeZone()")
    end

    assert_equal expected_time_zone, find("#user_time_zone", visible: :all).value
  end

  device_test "browser time zone refreshes the optional widget label and title" do
    visit edit_account_onboarding_user_detail_path(@user)
    expected_time_zone = detected_time_zone
    widget = find("#select2-user_time_zone-container")
    page.execute_script <<~JS
      const widget = document.querySelector("#select2-user_time_zone-container");
      widget.title = "Previous time zone";
      widget.textContent = "Previous time zone";
    JS

    assert_no_js_errors do
      page.execute_script("btSetUserTimeZone()")
    end

    assert_equal expected_time_zone, find("#user_time_zone", visible: :all).value
    selected_label = page.evaluate_script('document.querySelector("#user_time_zone").selectedOptions[0].text')
    assert_equal selected_label, widget.text
    assert_equal selected_label, widget[:title]
  end

  private

  def detected_time_zone
    browser_time_zone = page.evaluate_script("jstz.determine().name()")
    ActiveSupport::TimeZone::MAPPING.invert.fetch(browser_time_zone)
  end
end
