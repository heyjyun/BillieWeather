class Api::V1::ApplicationController < ActionController::API
  include Api::Controllers::Base
  before_action :require_usage_region

  private

  def require_usage_region
    if current_user.needs_usage_region?
      render json: {error: "usage_region_required", message: I18n.t("billie.region.required_notice"),
                    settings_path: finance_settings_path}, status: :unprocessable_entity
    end
  end
end
