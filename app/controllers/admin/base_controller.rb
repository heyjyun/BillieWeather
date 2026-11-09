module Admin
  # Admin pages for manual community management. Access is checked on the server for
  # every request: only accounts listed in DEVELOPER_EMAILS (the same rule that guards
  # /admin/avo) get through; everyone else receives a 404.
  class BaseController < ApplicationController
    layout "billie"
    before_action :authenticate_user!
    before_action :require_admin
    after_action { response.headers["Cache-Control"] = "no-store, private" }

    private

    def require_admin
      head :not_found unless current_user.developer?
    end

    def find_member
      @member = User.find(params[:user_id] || params[:id])
    end

    # datetime-local fields carry no zone; read them in the admin's own time zone.
    def parse_admin_time(value)
      return nil if value.blank?
      Time.use_zone(current_user.time_zone.presence || "UTC") { Time.zone.parse(value.to_s) }
    rescue ArgumentError
      nil
    end
  end
end
