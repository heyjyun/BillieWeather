# The quick login buttons (Example Account, personal account) sign in and so rotate the CSRF
# token. A second click, a resubmitted page or a stale tab then posts the old token. Reject it
# without touching the session, and answer with a redirect instead of an exception page:
# to the dashboard when this browser is already signed in to the account the button picks,
# otherwise back to the account choice.
module QuickLoginCsrf
  extend ActiveSupport::Concern

  included do
    rescue_from ActionController::InvalidAuthenticityToken, with: :quick_login_page_expired
  end

  private

  # The account this button signs in to, or nil when none is available.
  def quick_login_target
    raise NotImplementedError
  end

  def quick_login_page_expired(error)
    raise error unless action_name == "create"

    response.headers["Cache-Control"] = "no-store, private"
    # Reads only the existing session; the rejected request authenticates nothing.
    signed_in = warden.user(:user)
    if signed_in && signed_in == quick_login_target
      return redirect_to finance_dashboard_path, status: :see_other
    end

    # CSRF verification runs before set_locale, so choose from visitor preferences only.
    locale = [request.query_parameters["locale"], cookies.signed[:billie_locale],
      browser_locale, I18n.default_locale.to_s]
      .find { |value| value.is_a?(String) && I18n.available_locales.include?(value.to_sym) }
    redirect_to new_user_session_path, status: :see_other,
      alert: I18n.t("billie.auth.page_expired", locale: locale)
  end
end
