class ApplicationController < ActionController::Base
  include Controllers::Base

  protect_from_forgery with: :exception, prepend: true
  before_action :configure_billie_authentication, if: :devise_controller?

  def after_sign_in_path_for(resource_or_scope)
    stored_location_for(resource_or_scope) || finance_dashboard_path
  end

  def after_sign_up_path_for(resource_or_scope)
    finance_dashboard_path
  end

  private

  def configure_billie_authentication
    devise_parameter_sanitizer.permit(:sign_up, keys: [:first_name, :last_name])
  end
end
