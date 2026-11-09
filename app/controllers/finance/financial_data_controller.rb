module Finance
  # Privacy & Data → "Delete my financial data". Only ever acts on the signed-in person;
  # it takes no id, so there is no way to point it at someone else's records.
  class FinancialDataController < BaseController
    skip_before_action :require_usage_region

    def destroy
      confirmation = params.dig(:financial_data, :confirm_email)
      unless confirmation.is_a?(String) && confirmation.strip.casecmp?(current_user.email.to_s)
        return redirect_to finance_settings_path(anchor: "settings-privacy"), status: :see_other, alert: t("billie.privacy.confirmation_mismatch")
      end

      counts = DataDeletion.call(user: current_user)
      Rails.logger.info("Financial data deleted for user #{current_user.id}: #{counts.values.sum} rows")
      redirect_to finance_settings_path(anchor: "settings-privacy"), status: :see_other, notice: t("billie.privacy.data.deleted")
    rescue ActiveRecord::ActiveRecordError => error
      Rails.logger.error("Financial data deletion failed for user #{current_user.id}: #{error.class}")
      redirect_to finance_settings_path(anchor: "settings-privacy"), status: :see_other, alert: t("billie.privacy.data.failed")
    end
  end
end
