class GoogleRegionsController < ApplicationController
  layout "billie"
  before_action :load_pending_signup
  after_action :prevent_caching

  def new
    @user = User.new
  end

  def create
    region = params.require(:user).permit(:usage_region)[:usage_region].to_s.strip.upcase.presence
    @user = User.new(usage_region: region)
    unless UsageRegion::CODES.include?(region)
      @user.errors.add(:usage_region, region.nil? ? :blank : :inclusion)
      return render :new, status: :unprocessable_entity
    end

    service = GoogleSignIn.new(auth: @pending_auth, usage_region: region,
      allow_signup: show_sign_up_options?, create_team: session[:invitation_uuid].blank?)
    user = service.call
    session.delete(:pending_google_signup)
    sign_in(:user, user, event: :authentication)
    invitation_confirmation_path = accept_pending_invitation
    user.create_default_team unless user.teams.exists?
    user.send_welcome_email if service.created
    destination = after_sign_in_path_for(user)
    redirect_to invitation_confirmation_path || destination, status: :see_other, notice: t("billie.auth.google_signed_in")
  rescue GoogleSignIn::LinkRequired => error
    session.delete(:pending_google_signup)
    session[:pending_google_identity] = error.identity
    redirect_to new_user_session_path, status: :see_other, notice: error.message
  rescue GoogleSignIn::Error => error
    session.delete(:pending_google_signup)
    redirect_to new_user_session_path, status: :see_other, alert: error.message
  end

  private

  def load_pending_signup
    if user_signed_in?
      session.delete(:pending_google_signup)
      return redirect_to after_sign_in_path_for(current_user)
    end

    @pending_auth = GoogleSignIn.pending_signup_auth(session[:pending_google_signup]) if GoogleSignIn.configured?
    return if @pending_auth

    session.delete(:pending_google_signup)
    redirect_to new_user_session_path, alert: t("billie.google_region.expired")
  end

  def accept_pending_invitation
    uuid = session.delete(:invitation_uuid)
    return if uuid.blank?
    invitation = Invitation.find_by_uuid(uuid)
    return unless invitation
    # A different verified Google email must use the normal explicit acceptance
    # page rather than silently receiving the invited person's membership.
    return accept_account_invitation_path(uuid) unless invitation.is_for?(current_user)

    invitation.accept_for(current_user)
    nil
  end

  def prevent_caching
    response.headers["Cache-Control"] = "no-store, private"
  end
end
