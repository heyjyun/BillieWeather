module Community
  # The only way a payment QR image leaves the server. Allowed for:
  # * admins, always (so they can check their uploads, even while payments are off);
  # * signed-in friends an admin has invited, only while SUPPORT_PAYMENTS_ENABLED is
  #   on and only for methods the admin has enabled.
  # Everyone else gets a 404, whether or not a code exists.
  class PaymentQrCodesController < ApplicationController
    before_action :authenticate_user!

    def show
      payment_method = Community::PaymentMethod.find_by(key: params[:key])
      return head :not_found unless payment_method&.qr_present? && allowed?(payment_method)

      response.headers["Cache-Control"] = "no-store, private"
      response.headers["X-Robots-Tag"] = "noindex, nofollow"
      response.headers["X-Content-Type-Options"] = "nosniff"
      response.headers["Content-Security-Policy"] = "default-src 'none'; sandbox"
      send_data payment_method.qr_code.download, type: payment_method.qr_content_type,
        disposition: (params[:download] == "1") ? "attachment" : "inline", filename: payment_method.qr_filename
    end

    private

    def allowed?(payment_method)
      return true if current_user.developer?
      Community.payments_enabled? && current_user.support_payments_viewer? && payment_method.enabled?
    end
  end
end
