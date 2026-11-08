class PasswordsController < Devise::PasswordsController
  layout "billie"

  before_action :ensure_recovery_delivery_configured, only: [:new, :create]
  rescue_from BilliePostmarkDelivery::Error, with: :recovery_temporarily_unavailable

  private

  def ensure_recovery_delivery_configured
    return unless Rails.env.production?
    return if ENV["POSTMARK_API_TOKEN"].present? && ENV["MAIL_FROM"].present?

    recovery_temporarily_unavailable
  end

  def recovery_temporarily_unavailable
    redirect_to new_user_session_path,
      alert: t("billie.auth.recovery_unavailable"),
      status: :see_other
  end
end
