module Admin
  # Admin → Payment Methods: upload, preview, replace, or remove each QR code, and
  # choose which methods appear in the support modal. Changes take effect immediately;
  # nothing here touches source code or files in the repository.
  class PaymentMethodsController < BaseController
    before_action :find_payment_method, only: [:update, :remove_qr]

    def index
      @payment_methods = ::Community::PaymentMethod.all_for_display
    end

    def update
      attributes = params.fetch(:payment_method, {}).permit(:qr_upload, :enabled, :note_supported)
      @payment_method.qr_upload = attributes[:qr_upload]
      @payment_method.enabled = attributes[:enabled] == "1" if attributes.key?(:enabled)
      @payment_method.note_supported = attributes[:note_supported] == "1" if attributes.key?(:note_supported)
      @payment_method.updated_by = current_user
      if @payment_method.save
        back notice: t("billie.community.admin.payment_method_saved", method: @payment_method.label)
      else
        back alert: @payment_method.errors.full_messages.to_sentence
      end
    end

    def remove_qr
      @payment_method.remove_qr!(by: current_user) if @payment_method.persisted?
      back notice: t("billie.community.admin.qr_removed", method: @payment_method.label)
    end

    private

    def find_payment_method
      @payment_method = ::Community::PaymentMethod.for(params[:key])
    end

    def back(**flash)
      redirect_to admin_payment_methods_path(anchor: "payment-method-#{@payment_method.key}"), status: :see_other, **flash
    end
  end
end
