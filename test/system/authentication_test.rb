require "application_system_test_case"

class AuthenticationSystemTest < ApplicationSystemTestCase
  device_test "visitors can create an account, log in, and reset their password" do
    be_invited_to_sign_up
    new_registration_page_for(display_details)

    # Required fields are validated by the browser before the form is submitted.
    click_button "Create account"
    assert_selector "#user_first_name:invalid"
    assert_current_path new_user_registration_path

    fill_registration_form(first_name: "Testy", last_name: "McTesterson", email: "andrew.culver@gmail.com",
      password_confirmation: another_example_password)
    click_button "Create account"
    assert_current_path user_registration_path
    assert_selector "[role='alert']", text: "doesn't match Password"

    fill_in "user_password", with: example_password
    fill_in "user_password_confirmation", with: example_password
    click_button "Create account"
    assert_current_path finance_dashboard_path
    assert_selector ".bw-user", text: "Testy"

    user = User.find_by!(email: "andrew.culver@gmail.com")
    assert_equal "Testy", user.first_name
    assert_equal "McTesterson", user.last_name
    sign_out_for(display_details)

    be_invited_to_sign_up
    new_registration_page_for(display_details)
    fill_registration_form(first_name: "Testy", last_name: "McTesterson", email: user.email)
    click_button "Create account"
    assert_current_path user_registration_path
    assert_selector "[role='alert']", text: "Email address has already been taken"

    within ".bw-auth-switch" do
      click_link "Log in"
    end
    assert_selector "h1", text: "Your financial outlook awaits.", exact_text: true

    visit root_path
    new_session_page_for(display_details)
    fill_in "user_email", with: user.email
    fill_in "user_password", with: "notpassword1234"
    check "Keep me signed in"
    click_button "Log in"
    assert_current_path new_user_session_path
    assert_selector "[role='alert']", text: "Invalid email address or password."

    fill_in "user_email", with: user.email
    fill_in "user_password", with: example_password
    click_button "Log in"
    assert_current_path finance_dashboard_path
    assert_selector ".bw-user", text: user.email
    sign_out_for(display_details)

    new_session_page_for(display_details)
    click_link "Forgot your password?"
    assert_selector "h1", text: "Reset your password", exact_text: true

    click_button "Send reset link"
    assert_selector "#user_email:invalid"

    fill_in "user_email", with: "not.andrew.culver@gmail.com"
    click_button "Send reset link"
    assert_current_path user_password_path
    assert_selector "[role='alert']", text: "Email address not found"

    perform_enqueued_jobs do
      clear_emails
      fill_in "user_email", with: user.email
      click_button "Send reset link"
      assert_text("You will receive an email with instructions on how to reset your password in a few minutes.")
    end

    open_email user.email
    current_email.click_link "Change my password"
    assert_selector "h1", text: "Choose a new password", exact_text: true
    reset_url = current_url

    visit edit_user_password_path(reset_password_token: "invalid-token")
    fill_in "user_password", with: another_example_password
    fill_in "user_password_confirmation", with: another_example_password
    click_button "Update password"
    assert_current_path user_password_path
    assert_selector "[role='alert']", text: "Reset password token is invalid"

    visit reset_url
    fill_in "user_password", with: another_example_password
    fill_in "user_password_confirmation", with: example_password
    click_button "Update password"
    assert_current_path user_password_path
    assert_selector "[role='alert']", text: "doesn't match Password"

    fill_in "user_password", with: another_example_password
    fill_in "user_password_confirmation", with: another_example_password
    click_button "Update password"
    assert_current_path finance_dashboard_path
    assert user.reload.valid_password?(another_example_password)
    sign_out_for(display_details)
  end
end
