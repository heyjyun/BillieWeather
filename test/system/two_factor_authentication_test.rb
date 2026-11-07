require "application_system_test_case"

class TwoFactorAuthentication < ApplicationSystemTestCase
  if two_factor_authentication_enabled?
    setup do
      @jane = FactoryBot.create :two_factor_user, first_name: "Jane", last_name: "Smith"
      @john = FactoryBot.create :user, first_name: "John", last_name: "Smith"
    end

    device_test "a user can log in with a valid OTP" do
      visit new_user_session_path
      assert_selector "h1", text: "Your financial outlook awaits.", exact_text: true

      fill_in "user_email", with: @jane.email
      fill_in "user_password", with: @jane.password
      fill_in "Authentication code (if enabled)", with: @jane.otp.now

      click_button "Log in"

      assert_current_path finance_dashboard_path
    end

    device_test "a user cannot log in with an invalid OTP" do
      visit new_user_session_path
      assert_selector "h1", text: "Your financial outlook awaits.", exact_text: true

      fill_in "user_email", with: @jane.email
      fill_in "user_password", with: @jane.password
      fill_in "Authentication code (if enabled)", with: "invalid-code"

      click_button "Log in"

      assert_text("Invalid email address or password.")
      assert_current_path new_user_session_path
    end

    device_test "a user without OTP enabled can log in without an authentication code" do
      visit new_user_session_path
      assert_selector "h1", text: "Your financial outlook awaits.", exact_text: true

      fill_in "user_email", with: @john.email
      fill_in "user_password", with: @john.password

      assert_field "Authentication code (if enabled)", with: ""
      click_button "Log in"
      assert_current_path finance_dashboard_path
    end
  end
end
