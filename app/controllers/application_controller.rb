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

  # Keep the visitor's explicit choice across navigation, sign-in and sign-out.
  # with_locale also restores the previous locale when a request raises an error.
  def set_locale(&action)
    requested_locale = request.query_parameters["locale"]
    if requested_locale.is_a?(String) && I18n.available_locales.include?(requested_locale.to_sym)
      cookies.signed[:billie_locale] = {
        value: requested_locale, expires: 1.year.from_now, httponly: true, same_site: :lax, secure: request.ssl?
      }
    end
    locale = [
      requested_locale,
      cookies.signed[:billie_locale],
      current_user&.locale,
      current_user&.current_team&.locale,
      http_accept_language.compatible_language_from(I18n.available_locales)&.to_s,
      I18n.default_locale.to_s
    ].find { |value| value.is_a?(String) && I18n.available_locales.include?(value.to_sym) }
    I18n.with_locale(locale, &action)
  end

  def configure_billie_authentication
    devise_parameter_sanitizer.permit(:sign_up, keys: [:first_name, :last_name, :usage_region])
    devise_parameter_sanitizer.permit(:account_update, keys: [:usage_region])
  end
end
