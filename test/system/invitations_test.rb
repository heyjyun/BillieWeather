require "application_system_test_case"

class InvitationsTest < ApplicationSystemTestCase
  device_test "visitors can sign-up and manage team members with subscriptions #{billing_enabled? ? "enabled" : "disabled"}" do
    be_invited_to_sign_up

    visit user_session_path
    new_registration_page_for(display_details)

    fill_registration_form(first_name: "Hanako", last_name: "Tanaka", email: "hanako.tanaka@gmail.com")
    click_button "Create account"
    assert_current_path finance_dashboard_path

    # Team settings are managed separately from BillieWeather registration.
    membership_user = User.find_by!(email: "hanako.tanaka@gmail.com")
    visit edit_account_onboarding_user_detail_path(membership_user)
    assert_text("Tell us about you")
    fill_in "First Name", with: "Hanako"
    fill_in "Last Name", with: "Tanaka"
    fill_in "Your Team Name", with: "The Testing Team"
    click_on "Next"
    click_on "Skip" if bulk_invitations_enabled?

    if billing_enabled?
      unless freemium_enabled?
        complete_pricing_page
      end
    end

    assert_text("The Testing Team’s Dashboard")
    within_team_menu_for(display_details) do
      click_on "Team Members"
    end

    membership_user = User.find_by(email: "hanako.tanaka@gmail.com")
    first_membership = Membership.find_by(user: membership_user)

    assert_text("The Testing Team Team Members")

    # Paths that begin with "/account/" are whitelisted when accessing
    # invitation#new while passing a cancel_path to the params.
    hanakos_team = membership_user.current_team
    path_for_new_invitation = /invitations\/new/
    path_with_cancel_path_params = /invitations\/new\?cancel_path=/
    visit new_account_team_invitation_path(hanakos_team, cancel_path: account_team_memberships_path(hanakos_team))
    assert page.current_url.match?(path_with_cancel_path_params)

    # Make sure we cannot embed JavaScript when accessing the new invitation path.
    js_str = "javascript:alert('Testing')"
    visit new_account_team_invitation_path(hanakos_team, cancel_path: js_str)
    assert page.current_path.match?(path_for_new_invitation)
    assert !page.current_path.match?(js_str)
    assert !page.current_path.match?(path_with_cancel_path_params)

    # Paths that don't start with /account/ are not accepted either.
    faulty_link = "/memberships/"
    assert page.current_path.match?(path_for_new_invitation)
    visit new_account_team_invitation_path(hanakos_team, cancel_path: faulty_link)
    assert !page.current_path.match?(path_with_cancel_path_params)

    perform_enqueued_jobs do
      clear_emails

      fill_in "Email Address", with: "takashi.yamaguchi@gmail.com"
      fill_in "First Name", with: "Takashi"
      fill_in "Last Name", with: "Yamaguchi"
      find("label", text: "Invite as Team Administrator").click
      click_on "Create Invitation"
      wait_for_team_page account_team_memberships_path(hanakos_team)
      assert_text("Invitation was successfully created.")
    end

    invited_membership = Membership.find_by(user_email: "takashi.yamaguchi@gmail.com")
    invited_membership.invitation

    within_current_memberships_table do
      assert_text("Takashi Yamaguchi")
      within_membership_row(invited_membership) do
        assert_text("Invited")
        assert_text("Team Administrator")
      end
    end

    # Resend the invite
    assert_text("Resend")
    assert_difference "all_emails.count", 1 do
      perform_enqueued_jobs do
        click_on "Resend"
        wait_for_team_page account_team_memberships_path(hanakos_team)
        assert_text("Invitation was successfully resent.")
      end
    end

    # Prep a new window for making sure we can't resend invitations for tombstoned memberships.
    new_window = open_new_window
    within_window new_window do
      visit account_team_memberships_path(hanakos_team)
    end

    within_membership_row(invited_membership) do
      click_on "Details"
    end

    wait_for_team_page account_membership_path(invited_membership)
    assert_text("Invitation Details")

    accept_alert { click_on "Remove from Team" }
    wait_for_team_page account_team_memberships_path(hanakos_team)
    assert_text("That user has been successfully removed from the team.")

    # We shouldn't be able to resend invitations for memberships that aren't on the team anymore.
    within_window new_window do
      click_on "Resend"
      assert_current_path finance_dashboard_path
      assert_selector "[role='alert']", text: "Sorry, we couldn't find an invitation to resend."
    end
    new_window.close

    # click the link in the email.
    # yes, this is a totally valid thing to do if you have access to the invitation email.
    # practically speaking this would almost never happen, but it's a legitimate way to device_test this functionality without
    # introducing more time-consuming steps.
    open_email "takashi.yamaguchi@gmail.com"
    current_email.click_link "Join The Testing Team"

    # An expired invitation returns to the dashboard without granting membership.
    assert_current_path finance_dashboard_path
    assert_selector "[role='alert']", text: "Sorry, but we couldn't find your invitation."
    visit account_team_path(hanakos_team)
    within_team_menu_for(display_details) do
      click_on "Team Members"
    end

    wait_for_team_page account_team_memberships_path(hanakos_team)
    assert_text("The Testing Team Team Members")

    perform_enqueued_jobs do
      clear_emails

      within_former_memberships_table do
        assert_text("Takashi Yamaguchi")
        within_membership_row(invited_membership) do
          assert page.has_no_content?("Invited")
          assert_text("Team Administrator")
          accept_alert { click_link "Re-Invite to Team", exact: true }
        end
      end

      wait_for_team_page account_team_memberships_path(hanakos_team)
      assert_text("The user has been successfully re-invited. They will receive an email to rejoin the team.")
    end

    # Make sure we can resend the invitation for memberships that come back to the team.
    assert_difference "all_emails.count", 1 do
      perform_enqueued_jobs do
        click_on "Resend"
        wait_for_team_page account_team_memberships_path(hanakos_team)
        assert_text("Invitation was successfully resent.")
      end
    end

    # sign out.
    sign_out_for(display_details)

    # click the link in the email.
    open_email "takashi.yamaguchi@gmail.com"
    current_email.click_link "Join The Testing Team"

    assert_selector "h1", text: "Create your account", exact_text: true
    # this email address is purposefully different than the one they were invited via.
    # The first name is also different from the invitation's name.
    fill_registration_form(first_name: "Taka", last_name: "Yamaguchi", email: "takashi@yamaguchi.com",
      password: another_example_password)
    click_button "Create account"

    # The email was sent to takashi.yamaguchi@gmail.com,
    # but since the user signed up with the email takashi@yamaguchi.com,
    # we have to confirm that we actually want to join the team under this account.
    click_on "Join The Testing Team"

    assert_current_path finance_dashboard_path
    assert_selector "[role='status']", text: "Welcome to The Testing Team!"
    visit account_team_path(hanakos_team)
    within_team_menu_for(display_details) do
      click_on "Team Members"
    end

    assert_text("Hanako Tanaka")

    membership_user = User.find_by(first_name: "Taka", last_name: "Yamaguchi")
    last_membership = Membership.find_by(user: membership_user)

    within_current_memberships_table do
      assert_text("Taka Yamaguchi")
      within_membership_row(last_membership) do
        assert page.has_no_content?("Invited")
        assert_text("Team Administrator")
        click_on "Details"
      end
    end

    assert_text("Taka Yamaguchi’s Membership on The Testing Team")

    # Users cannot create another team in invitation-only mode.
    unless invitation_only?
      within_user_menu_for(display_details) do
        click_on "Add New Team"
      end

      assert_text("Create a New Team")
      fill_in "Team Name", with: "Another Team"
      click_on "Create Team"

      if billing_enabled?
        unless freemium_enabled?
          complete_pricing_page
        end
      end

      assert_text("Another Team’s Dashboard")
      within_team_menu_for(display_details) do
        click_on "Team Members"
      end

      assert_text("Another Team Team Members")
      click_on "Invite a New Team Member"

      assert_text("New Invitation Details")

      perform_enqueued_jobs do
        clear_emails

        # this is specifically a different email address than the one they signed up with originally.
        fill_in "Email Address", with: "hanako@some-company.com"
        click_on "Create Invitation"
        wait_for_team_page account_team_memberships_path(membership_user.reload.current_team)
        assert_text("Invitation was successfully created.")
      end

      # sign out.
      sign_out_for(display_details)

      invited_membership = Membership.find_by(user_email: "hanako@some-company.com")

      # # click the link in the email.
      open_email "hanako@some-company.com"
      current_email.click_link "Join Another Team"

      assert_selector "h1", text: "Create your account", exact_text: true
      within ".bw-auth-switch" do
        click_link "Log in"
      end

      assert_selector "h1", text: "Your financial outlook awaits.", exact_text: true
      fill_in "user_email", with: "hanako.tanaka@gmail.com"
      fill_in "user_password", with: example_password
      click_button "Log in"

      assert_text("Join Another Team")
      assert_text("Taka Yamaguchi has invited you to join Another Team")
      assert_text("This invitation was emailed to hanako@some-company.com")
      assert_text("but you're currently signed in as hanako.tanaka@gmail.com")
      click_on "Join Another Team"

      assert_current_path finance_dashboard_path
      assert_selector "[role='status']", text: "Welcome to Another Team!"
      membership_user = User.find_by!(email: "hanako.tanaka@gmail.com")
      visit account_team_path(membership_user.current_team)

      within_team_menu_for(display_details) do
        click_on "Team Members"
      end

      last_membership = Membership.find_by(user_email: "hanako@some-company.com")

      within_current_memberships_table do
        assert_text("Hanako Tanaka")
        within_membership_row(last_membership) do
          assert page.has_no_content?("Invited")
          assert_text("Viewer")
          click_on "Details"
        end
      end

      wait_for_team_page account_membership_path(last_membership)
      accept_alert { click_on "Leave This Team" }

      assert_current_path finance_dashboard_path
      assert_selector "[role='status']", text: "You've successfully removed yourself from Another Team."
      visit account_team_path(hanakos_team)
      assert_text("The Testing Team’s Dashboard")
    end

    # Make sure we're actually signed in as Hanako and on the Team Members page.
    sign_out_for(display_details)
    new_session_page_for(display_details)
    fill_in "user_email", with: "hanako.tanaka@gmail.com"
    fill_in "user_password", with: example_password
    click_button "Log in"
    assert_current_path finance_dashboard_path
    visit account_team_path(hanakos_team)
    within_team_menu_for(display_details) do
      click_on "Team Members"
    end

    assert_text("The Testing Team Team Members")
    within_current_memberships_table do
      assert_text("Hanako Tanaka")
      within_membership_row(first_membership) do
        assert_text("Team Administrator")
        click_on "Details"
      end
    end

    wait_for_team_page account_membership_path(first_membership)
    assert_text("Hanako Tanaka’s Membership on The Testing Team")
    accept_alert { click_on "Demote from Admin" }

    wait_for_team_page account_team_memberships_path(hanakos_team)
    assert_text("The Testing Team Team Members")
    within_current_memberships_table do
      assert_text("Hanako Tanaka")
      within_membership_row(first_membership) do
        assert page.has_no_content?("Team Administrator")
        click_on "Details"
      end
    end

    wait_for_team_page account_membership_path(first_membership)
    assert_text("Hanako Tanaka’s Membership on The Testing Team")

    # since the user is no longer an admin, they shouldn't see either of these options anymore.
    assert_text("Viewer")
    assert page.has_no_content?("Promote to Admin")
    assert page.has_no_content?("Demote from Admin")

    accept_alert { click_on "Leave This Team" }

    # if this is happening, it shouldn't be.
    assert page.has_no_content?("You are not authorized to access this page.")

    assert_text("You've successfully removed yourself from The Testing Team.")

    assert_text("Join a Team")
    assert_text("The account hanako.tanaka@gmail.com is not currently a member of any teams.")
    assert_text("Accept an invitation")
    assert_text("Log out of this account")
    assert_text("Create a new team")

    click_on "Logout"
  end

  private

  def wait_for_team_page(path)
    assert_current_path path
    page.document.synchronize do
      ready = page.evaluate_script(<<~JS)
        window.Turbo?.session?.started === true &&
          !window.Turbo.navigator.currentVisit &&
          !document.documentElement.hasAttribute("data-turbo-preview")
      JS
      raise Capybara::ElementNotFound, "Waiting for the final team page and its confirmation handlers" unless ready
    end
    # Turn can still animate rendered content before confirmation links are ready.
    assert_selector "html:not(.turn-advance):not(.turn-replace):not(.turn-restore):not([data-turbo-preview])"
  end
end
