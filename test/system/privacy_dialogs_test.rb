require "application_system_test_case"

class PrivacyDialogsTest < ApplicationSystemTestCase
  PASSWORD = "a-long-test-password-1"

  test "the two buttons open small dialogs; deleting financial data still works from inside" do
    user = create(:onboarded_user, email: "dialog@example.com", password: PASSWORD, password_confirmation: PASSWORD, usage_region: "US")
    Finance::StatementImporter.new(user: user, file: Rack::Test::UploadedFile.new(Rails.root.join("packages/finance-core/fixtures/statements/basic-amount.csv"), "text/csv", original_filename: "basic-amount.csv"), currency: "USD").call

    visit new_user_session_path(locale: "en")
    fill_in "user_email", with: user.email
    fill_in "user_password", with: PASSWORD
    find("form input[type='submit'], form button[type='submit']", match: :first).click
    assert_no_current_path new_user_session_path
    visit finance_settings_path(locale: "en")

    assert_no_selector "dialog[open]"
    assert_no_text "All imported transactions"
    click_button "Delete my account"
    assert_selector "dialog#privacy-delete-account-dialog[open]"
    find("dialog#privacy-delete-account-dialog").send_keys(:escape)
    assert_no_selector "dialog[open]"

    click_button "Delete my financial data"
    within("dialog#privacy-delete-data-dialog[open]") do
      assert_text "1 statement(s)"
      fill_in "financial_data[confirm_email]", with: user.email
      click_button "Delete my financial data"
    end
    assert_text I18n.t("billie.privacy.data.deleted", locale: :en)
    assert_equal 0, Finance::Transaction.where(user_id: user.id).count
  end
end
