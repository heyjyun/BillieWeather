require "application_system_test_case"

class SidebarCustomizationTest < ApplicationSystemTestCase
  test "a visibility switch updates the reorder controls and navigation before a reload" do
    login_as(create(:onboarded_user, usage_region: "US"), scope: :user)
    visit finance_settings_path(locale: "en")
    assert_equal ["Financial Overview", "AI Insight", "Settings"], all("#module-nav a").map(&:text)
    within("#settings-feature-library") do
      find("#module-transactions [role=switch]").click
      assert_selector "#module-transactions [aria-checked=true]"
    end
    within("[data-sidebar-order]") do
      assert_selector "li:first-child[data-module-key=overview]"
      find("button[aria-label='Move Financial Overview down']").send_keys(:enter)
    end
    assert_selector "[data-sidebar-order] li:nth-child(2)[data-module-key=overview]"
    visit finance_settings_path(locale: "en")
    assert_selector "#module-nav .bw-business-nav a:nth-child(2)", text: "Financial Overview"
    assert_selector "[data-module-group=intelligence] li:first-child[data-module=overview]"
    click_button "Restore default sidebar"
    assert_equal ["Financial Overview", "AI Insight", "Settings"], all("#module-nav a").map(&:text)
    assert_selector "#module-nav > .bw-system-nav a", text: "Settings"
    find("#module-transactions a.bw-feature-open").click
    assert_current_path finance_transactions_path, ignore_query: true
  end
end
