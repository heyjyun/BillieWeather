module ApplicationHelper
  include Helpers::Base

  def current_theme
    :light
  end

  def google_sign_in_enabled?
    GoogleSignIn.configured?
  end
end
