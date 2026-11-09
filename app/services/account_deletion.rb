# "Delete my account". Bullet Train ships no user self-deletion workflow (its
# Account::UsersController has no destroy action), so this sits behind Devise's own
# DELETE /users endpoint (RegistrationsController#destroy) and adds what that endpoint lacks:
# - explicit confirmation (typed email, plus the current password for password accounts),
# - a refusal when the person shares a team with anyone else, so shared team data is never
#   deleted on one member's say-so,
# - removal of the person's own one-member teams, which Bullet Train would otherwise leave
#   behind with no members.
# Everything happens in one transaction; on any failure nothing is deleted.
class AccountDeletion
  attr_reader :error

  def initialize(user, password: nil, confirmation: nil)
    @user = user
    @password = password.to_s
    @confirmation = confirmation.to_s
  end

  # People who signed up with Google were given a random password they never saw.
  def password_required?
    @user.google_uid.blank?
  end

  def shared_teams
    Team.joins(:memberships).where(memberships: {user_id: @user.id}).distinct.select do |team|
      Membership.where(team_id: team.id).where.not(user_id: nil).where.not(user_id: @user.id).exists?
    end
  end

  def blockers
    list = shared_teams.map { |team| I18n.t("billie.privacy.account.shared_team", team: team.name) }
    if @user.respond_to?(:oauth_stripe_accounts) && @user.oauth_stripe_accounts.exists?
      list << I18n.t("billie.privacy.account.connected_integrations")
    end
    list << I18n.t("billie.privacy.account.platform_agent") if @user.platform_agent_of_id.present?
    list
  end

  def call
    return fail_with(I18n.t("billie.privacy.confirmation_mismatch")) unless confirmed_email?
    return fail_with(I18n.t("billie.privacy.account.wrong_password")) if password_required? && !@user.valid_password?(@password)
    blocked = blockers
    return fail_with(blocked.to_sentence) if blocked.any?

    ActiveRecord::Base.transaction do
      @user.lock!
      # Re-check under the lock: someone may have joined a team since the page was loaded.
      raise ActiveRecord::Rollback if shared_teams.any?
      Finance::DataDeletion.new(user: @user).delete_records!
      own_team_ids = Membership.where(user_id: @user.id).pluck(:team_id).uniq
      Team.where(id: own_team_ids).find_each do |team|
        # Pending invitations and invitation lists of a one-member team were made by this person.
        # Bullet Train's Team does not remove them itself and their foreign keys block the team.
        Membership.where(team_id: team.id).update_all(invitation_id: nil)
        Invitation.where(team_id: team.id).delete_all
        Account::Onboarding::InvitationList.where(team_id: team.id).delete_all
        team.destroy!
      end
      @user.reload.destroy!
      @deleted = true
    end
    return fail_with(I18n.t("billie.privacy.account.shared_team_generic")) unless @deleted

    Finance::DataDeletion.clear_cached_forecasts(@user.id)
    true
  rescue ActiveRecord::ActiveRecordError => exception
    Rails.logger.error("Account deletion failed for user #{@user.id}: #{exception.class}")
    fail_with(I18n.t("billie.privacy.account.failed"))
  end

  private

  def confirmed_email?
    @confirmation.strip.casecmp?(@user.email.to_s)
  end

  def fail_with(message)
    @error = message
    false
  end
end
