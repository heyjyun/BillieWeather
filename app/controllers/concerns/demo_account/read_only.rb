module DemoAccount
  # The Example Account is shared by everyone who tries it, so it is read-only on the server:
  # every request that could change something (anything but GET/HEAD) is refused before the
  # controller runs, except signing out and switching accounts. Page buttons may still be
  # visible; this check is what makes them harmless.
  module ReadOnly
    extend ActiveSupport::Concern

    ALLOWED_WRITES = {
      "sessions" => %w[destroy],
      "demo_sessions" => %w[create],
      "remembered_accounts" => %w[destroy]
    }.freeze

    included do
      before_action :enforce_demo_read_only
    end

    private

    def enforce_demo_read_only
      return if request.get? || request.head?
      return if ALLOWED_WRITES.fetch(controller_name, []).include?(action_name)
      # warden.user reads the session only. It never runs a sign-in strategy, so it cannot
      # authenticate credentials submitted with this request (see SessionsController).
      user = warden.user(:user)
      return unless user&.demo_account?

      message = t("billie.quick_access.demo.read_only")
      if request.format.json?
        render json: {error: "demo_read_only", message: message}, status: :forbidden
      else
        redirect_back fallback_location: finance_dashboard_path, status: :see_other, alert: message
      end
    end
  end
end
