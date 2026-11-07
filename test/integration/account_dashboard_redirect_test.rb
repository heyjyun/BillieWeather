require "test_helper"

class AccountDashboardRedirectTest < ActionDispatch::IntegrationTest
  include Devise::Test::IntegrationHelpers

  setup do
    @user = create(:onboarded_user)
    @team = @user.current_team
    sign_in @user
  end

  test "a canceled invitation resend alert survives the dashboard redirect" do
    invitation = create_invitation("invited@example.com")
    invitation_uuid = invitation.uuid
    invitation.destroy!

    post resend_account_invitation_path(invitation_uuid)
    assert_redirected_to account_dashboard_path
    follow_redirect!
    assert_redirected_to finance_dashboard_path
    follow_redirect!
    assert_response :success
    assert_select "[role='alert']", text: "Sorry, we couldn't find an invitation to resend."

    get finance_dashboard_path
    assert_select "[role='alert']", text: "Sorry, we couldn't find an invitation to resend.", count: 0
  end

  test "an accepted invitation notice survives the dashboard redirect" do
    recipient = create(:onboarded_user)
    invitation = create_invitation(recipient.email)
    sign_out @user
    sign_in recipient

    get accept_account_invitation_path(invitation.uuid)
    assert_redirected_to account_dashboard_path
    follow_redirect!
    assert_redirected_to finance_dashboard_path
    follow_redirect!
    assert_response :success
    assert_select "[role='status']", text: "Welcome to #{@team.name}!"
    assert recipient.reload.teams.exists?(@team.id)

    get finance_dashboard_path
    assert_select "[role='status']", text: "Welcome to #{@team.name}!", count: 0
  end

  test "a Turbo invitation error remains visible after the finance layout reload" do
    invitation = create_invitation("invited@example.com")
    invitation_uuid = invitation.uuid
    invitation.destroy!
    turbo_headers = {"Accept" => "text/vnd.turbo-stream.html, text/html, application/xhtml+xml"}

    post resend_account_invitation_path(invitation_uuid), headers: turbo_headers
    assert_redirected_to account_dashboard_path
    follow_redirect!(headers: turbo_headers)
    assert_redirected_to finance_dashboard_path
    follow_redirect!(headers: turbo_headers)
    assert_response :success

    # Turbo reloads when leaving the account layout's tracked assets behind.
    get finance_dashboard_path
    assert_select "[role='alert']", text: "Sorry, we couldn't find an invitation to resend."

    get finance_dashboard_path
    assert_select "[role='alert']", text: "Sorry, we couldn't find an invitation to resend.", count: 0
  end

  test "a Turbo invitation notice remains visible after the finance layout reload" do
    recipient = create(:onboarded_user)
    invitation = create_invitation(recipient.email)
    sign_out @user
    sign_in recipient
    turbo_headers = {"Accept" => "text/vnd.turbo-stream.html, text/html, application/xhtml+xml"}

    post accept_account_invitation_path(invitation.uuid), headers: turbo_headers
    assert_redirected_to account_dashboard_path
    follow_redirect!(headers: turbo_headers)
    assert_redirected_to finance_dashboard_path
    follow_redirect!(headers: turbo_headers)
    assert_response :success

    get finance_dashboard_path
    assert_select "[role='status']", text: "Welcome to #{@team.name}!"

    get finance_dashboard_path
    assert_select "[role='status']", text: "Welcome to #{@team.name}!", count: 0
  end

  private

  def create_invitation(email)
    Invitation.create!(team: @team, email: email, from_membership: @user.memberships.first,
      membership: Membership.new(team: @team, user_email: email))
  end
end
