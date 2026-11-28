require "application_system_test_case"

class FinanceAssistantSystemTest < ApplicationSystemTestCase
  test "a person edits and confirms a batch and dismisses the post-save suggestion" do
    person = create(:onboarded_user, usage_region: "US")
    login_as(person, scope: :user)
    visit finance_accounts_path(locale: "en")
    fill_in "Describe your accounts", with: "A Chase credit card with $500 outstanding and an Alipay wallet"
    click_button "Review proposed accounts"
    assert_selector "fieldset", count: 2
    within(all("fieldset").first) do
      fill_in "Account name", with: "My reviewed card"
      find_field("Balance date").set(Date.current)
      assert_equal Date.current.iso8601, find_field("Balance date").value
    end
    assert_empty person.finance_bank_accounts
    click_button "Confirm selected accounts"
    assert_text "My reviewed card"
    assert_text "Balance pending confirmation"
    assert_text "Your accounts are ready"
    click_button "Dismiss"
    visit finance_accounts_path(locale: "en")
    assert_no_text "Your accounts are ready"
    card = person.finance_bank_accounts.find_by!(custom_name: "My reviewed card")
    assert_equal(-500, card.balance)
    origins = person.finance_audit_events.find_by!(subject_type:"BankAccount",subject_id:card.id.to_s,action:"create").changes_data.fetch("origins")
    assert_equal ["edited","suggested","text"],origins.values_at("name","currency","amount")
  end
end
