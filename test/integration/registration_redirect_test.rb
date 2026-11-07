require "test_helper"

class RegistrationRedirectTest < ActionDispatch::IntegrationTest
  test "ordinary signup opens the finance dashboard" do
    get new_user_registration_path
    post user_registration_path, params: registration_params("ordinary-signup@example.com")

    assert_redirected_to finance_dashboard_path
  end

  test "signup from a team invitation returns to the invitation and accepts its membership" do
    inviter = create(:onboarded_user)
    team = inviter.current_team
    email = "invited-signup@example.com"
    membership = team.memberships.build(user_email: email)
    invitation = Invitation.create!(team: team, from_membership: inviter.memberships.first,
      email: email, membership: membership)

    get accept_account_invitation_path(invitation.uuid)
    assert_redirected_to new_user_registration_path(invitation_uuid: invitation.uuid)
    follow_redirect!
    assert_response :success

    post user_registration_path, params: registration_params(email)
    assert_redirected_to accept_account_invitation_path(invitation.uuid)
    follow_redirect!

    user = User.find_by!(email: email)
    assert_equal user, membership.reload.user
    assert_equal team, user.current_team
    assert_equal [team.id], user.team_ids
    assert_not Invitation.exists?(invitation.id)
    assert_redirected_to account_dashboard_path
  end

  private

  def registration_params(email)
    {user: {first_name: "Alex", last_name: "River", email: email,
            password: "Gr33nCloud!Rain&2026", password_confirmation: "Gr33nCloud!Rain&2026"}}
  end
end
