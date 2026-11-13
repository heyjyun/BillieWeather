# "Quick Login — heyjyun": signs this browser in to the one personal account configured on the
# server (see PersonalAccount). The request cannot name any other user. It needs the page's
# CSRF token, and the account's password unless PersonalAccount.passwordless? (local
# development only).
class PersonalSessionsController < ApplicationController
  # Bullet Train callbacks may read current_user; verify the form first, as SessionsController does.
  prepend_before_action :verify_authenticity_token, only: :create
  rate_limit to: 10, within: 1.minute, by: -> { request.remote_ip }, only: :create,
    with: -> { redirect_to new_user_session_path, status: :see_other, alert: t("billie.quick_access.demo.rate_limited") }
  after_action { response.headers["Cache-Control"] = "no-store, private" }

  def create
    user = PersonalAccount.user
    return refuse(t("billie.quick_access.personal.unavailable")) unless user
    return refuse(t("billie.quick_access.personal.invalid_password")) unless PersonalAccount.passwordless?(request) || authenticated?(user)

    # Leaving the demo (or any other session) first: the two must never share one browser session.
    sign_out(:user) if warden.user(:user)
    sign_in(:user, user, event: :authentication)
    redirect_to after_sign_in_path_for(user), status: :see_other
  end

  private

  # The same checks as the ordinary form: password, lockable's attempt counter, two-factor code.
  def authenticated?(user)
    password = params[:password].to_s
    return false if password.empty?

    user.valid_for_authentication? do
      next false unless user.valid_password?(password)
      next true unless user.otp_required_for_login?
      user.respond_to?(:validate_and_consume_otp!) && user.validate_and_consume_otp!(params[:otp_attempt].to_s)
    end == true
  end

  def refuse(message)
    redirect_to new_user_session_path, status: :see_other, alert: message
  end
end
