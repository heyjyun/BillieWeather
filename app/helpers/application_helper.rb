module ApplicationHelper
  include Helpers::Base

  def current_theme
    :light
  end

  def google_sign_in_enabled?
    GoogleSignIn.configured?
  end

  def usage_region_options
    UsageRegion::CODES.map { |code| [t("usage_regions.#{code}"), code] }
      .sort_by { |label, _code| label.downcase }
  end

  def billie_language_path(locale)
    # Failed form submissions may render at a URL without a GET action.
    path = if request.get?
      request.path
    elsif devise_controller?
      case controller_name
      when "registrations" then new_user_registration_path
      when "passwords" then new_user_password_path
      else new_user_session_path
      end
    else
      finance_dashboard_path
    end
    query = (request.get? ? request.query_parameters : {}).merge("locale" => locale)
    "#{path}?#{query.to_query}"
  end
end
