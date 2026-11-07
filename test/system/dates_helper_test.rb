require "application_system_test_case"

class DatesHelperTest < ApplicationSystemTestCase
  setup do
    @original_hide_things = ENV["HIDE_THINGS"]
    ENV["HIDE_THINGS"] = "false"
    Rails.application.reload_routes!
  end

  teardown do
    ENV["HIDE_THINGS"] = @original_hide_things
    Rails.application.reload_routes!
  end

  device_test "Time is displayed correctly" do
    user = create :onboarded_user, first_name: "Testy", last_name: "McTesterson", time_zone: "UTC"
    team = user.current_team
    login_as(user, scope: :user)
    visit account_team_path(team)

    if billing_enabled?
      unless freemium_enabled?
        complete_pricing_page
      end
    end

    # Create a Tangible Thing
    click_on "Creative Concepts"
    click_on "Add New Creative Concept"
    fill_in "Name", with: "Test Concept"
    fill_in "Description", with: "Test Description"
    click_on "Create Creative Concept"
    click_on "Add New Tangible Thing"
    fill_in "Text Field Value", with: "Test Tangible Thing"
    click_on "Create Tangible Thing"
    assert page.has_text? "Tangible Thing was successfully created."

    time = Scaffolding::CompletelyConcrete::TangibleThing.first.created_at

    # Go to the Tangible Thing's index page.
    click_on "Back"

    # Assert today's date is displayed correctly.
    assert_text "Today at #{time.strftime("%l:%M %p").strip}"

    # Assert yesterday's date is displayed correctly.
    travel_to time + 1.day
    visit current_url # Refresh the page
    assert_text "Yesterday at #{time.strftime("%l:%M %p").strip}"

    # Assert the month and day is shown for anything before then.
    travel_to time + 2.days
    visit current_url

    # We have to assert these two things separately so it doesn't fail on the last day of the year when the year is present.
    assert_text time.strftime("%B %-d").strip.to_s
    assert_text "at #{time.strftime("%l:%M %p").strip}"

    # Create a new record in a different time zone.
    Time.zone = "Tokyo"

    # No need to check the strings on the page if the record
    # is successfully created and the times below are different.
    visit account_team_path(team)
    click_on "Test Concept"
    click_on "Add New Tangible Thing"
    fill_in "Text Field Value", with: "Another Test Tangible Thing"
    click_on "Create Tangible Thing"
    assert page.has_text? "Tangible Thing was successfully created."

    # Compare by hours instead of seconds/minutes for accuracy.
    tokyo_time = Scaffolding::CompletelyConcrete::TangibleThing.find_by(text_field_value: "Another Test Tangible Thing").created_at
    refute time.strftime("%l").to_i == tokyo_time.strftime("%l").to_i

    # Even if we push UTC time forward by an hour,
    # it should still be behind Tokyo time.
    assert tokyo_time > (time + 1.hour)
  end
end
