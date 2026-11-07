require "application_system_test_case"

class FieldsTest < ApplicationSystemTestCase
  setup do
    @original_hide_things = ENV["HIDE_THINGS"]
    ENV["HIDE_THINGS"] = "false"
    Rails.application.reload_routes!
  end

  teardown do
    ENV["HIDE_THINGS"] = @original_hide_things
    Rails.application.reload_routes!
  end

  device_test "simulate restoring behavior of form fields on page restore" do
    user = create :onboarded_user, first_name: "John", last_name: "Doe", time_zone: "Brisbane"
    login_as(user, scope: :user)
    visit account_team_path(user.current_team)

    if billing_enabled?
      unless freemium_enabled?
        complete_pricing_page
      end
    end

    click_on "Add New Creative Concept"
    fill_in "Name", with: "My Generic Creative Concept"
    fill_in "Description", with: "Dummy description for my creative concept"
    click_on "Create Creative Concept"

    click_on "Add New Tangible Thing"

    select2_select "Multiple Super Select Values", ["Five", "Six"]
    super_select = find_stimulus_controller_for_label "Multiple Super Select Values", "fields--super-select"
    assert_no_js_errors do
      disconnect_stimulus_controller_on super_select
      reconnect_stimulus_controller_on super_select
      improperly_disconnect_and_reconnect_stimulus_controller_on super_select
      select2_select "Multiple Super Select Values", ["Four"]
      assert super_select.has_css?(".select2-container--default", count: 1)
    end

    button = find_stimulus_controller_for_label "Button Value", "fields--button-toggle"
    click_on "One"
    assert_no_js_errors do
      disconnect_stimulus_controller_on button
      reconnect_stimulus_controller_on button
      assert button.find('input[type="radio"]', visible: false)["checked"]
      improperly_disconnect_and_reconnect_stimulus_controller_on button # the radio button won't be checked because we're using innerHTML
    end

    phone_field_wrapper = find_stimulus_controller_for_label "Phone Field Value", "fields--phone", wrapper: true
    phone_field = phone_field_wrapper.first("input")
    "+1 613".chars.each do |digit|
      phone_field.send_keys(digit)
    end
    assert_no_js_errors do
      disconnect_stimulus_controller_on phone_field_wrapper
      reconnect_stimulus_controller_on phone_field_wrapper
      improperly_disconnect_and_reconnect_stimulus_controller_on phone_field_wrapper
      assert phone_field_wrapper.first(".iti__selected-flag")["title"] == "Canada: +1"
    end

    date_field = find_stimulus_controller_for_label "Date Field Value", "fields--date"
    assert_no_js_errors do
      disconnect_stimulus_controller_on date_field
      reconnect_stimulus_controller_on date_field
      improperly_disconnect_and_reconnect_stimulus_controller_on date_field
    end
  end
end
