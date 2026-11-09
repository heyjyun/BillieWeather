class SessionsController < Devise::SessionsController
  include Sessions::ControllerBase

  layout "billie"
  # Bullet Train reads current_user in its callbacks. On a login POST that can
  # authenticate the password and rotate the CSRF token, so verify the form first.
  prepend_before_action :verify_authenticity_token, only: :create
  after_action :prevent_sign_in_caching, only: [:new, :create]
  rescue_from ActionController::InvalidAuthenticityToken, with: :restart_sign_in

  def create
    super do |user|
      identity = session.delete(:pending_google_identity)
      if identity && GoogleSignIn.connect_after_password_sign_in!(user: user, identity: identity)
        flash[:notice] = t("billie.auth.google_connected")
      end
    end
  end

  private

  def prevent_sign_in_caching
    response.headers["Cache-Control"] = "no-store, private"
  end

  def restart_sign_in(error)
    raise error unless action_name == "create"

    # Reject the request without replaying credentials or clearing a valid login.
    prevent_sign_in_caching
    # CSRF verification runs before set_locale. Choose only visitor preferences
    # here: reading current_user could authenticate the rejected credentials.
    locale = [request.query_parameters["locale"], cookies.signed[:billie_locale],
      browser_locale, I18n.default_locale.to_s]
      .find { |value| value.is_a?(String) && I18n.available_locales.include?(value.to_sym) }
    redirect_to new_user_session_path, status: :see_other,
      alert: I18n.t("billie.auth.page_expired", locale: locale)
  end
end
