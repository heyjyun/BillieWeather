# "Try Example Account": signs this browser in to the shared, read-only demo (see
# DemoAccount). The server chooses the account; the request carries no credentials and
# cannot name any other user. A POST with the page's CSRF token, so another site cannot
# switch a visitor's session to the demo.
class DemoSessionsController < ApplicationController
  rate_limit to: 20, within: 1.minute, by: -> { request.remote_ip }, only: :create,
    with: -> { redirect_to new_user_session_path, status: :see_other, alert: t("billie.quick_access.demo.rate_limited") }
  after_action { response.headers["Cache-Control"] = "no-store, private" }

  def create
    demo = DemoAccount.enabled? ? DemoAccount.user : nil
    unless demo&.active_for_authentication?
      return redirect_to new_user_session_path, status: :see_other, alert: t("billie.quick_access.demo.unavailable")
    end

    # Leaving a personal session first: the two must never share one browser session.
    sign_out(:user) if warden.user(:user)
    sign_in(:user, demo, event: :authentication)
    # The layout's Example Account banner explains where the visitor is; no extra flash message.
    redirect_to finance_dashboard_path, status: :see_other
  end
end
