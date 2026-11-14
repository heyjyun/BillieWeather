module Finance
  # Website-side housekeeping for the local database cards: a display label for a device, and
  # review decisions for legacy or ambiguous records. Metadata only, always scoped to the
  # signed-in account (another account's ids simply are not found). Never contacts a device,
  # never deletes a record and never touches statements, transactions or rules.
  class LocalDevicesController < BaseController
    def update
      device = LocalDevice.find_by!(user_id: current_user.id, device_id: params[:device_id])
      previous = device.label
      if device.update(label: params.dig(:local_device, :label))
        LocalDatabaseAudit.record!(user_id: current_user.id, event: "device_renamed", device_id: device.device_id, from: previous, to: device.label) if previous != device.label
        redirect_to finance_settings_path(anchor: "settings-local-databases"), status: :see_other, notice: t("billie.database.local.renamed")
      else
        redirect_to finance_settings_path(anchor: "settings-local-databases"), status: :see_other, alert: t("billie.database.local.rename_invalid")
      end
    end

    # "archive" hides a record from review (kept for the audit trail); "restore" brings an
    # archived or reviewed record back to the device's card.
    def review
      report = LocalDatabaseReport.live.find_by!(user_id: current_user.id, id: params[:id])
      decision = params[:decision].to_s
      return head :unprocessable_entity unless %w[archive restore].include?(decision)
      return head :unprocessable_entity if decision == "archive" && report.status == "archived"
      return head :unprocessable_entity if decision == "restore" && report.status == "active"

      LocalDatabaseReport.transaction do
        LocalDatabaseAudit.record!(user_id: current_user.id, event: (decision == "archive") ? "review_archived" : "review_restored",
          device_id: report.device_id, database_id: report.database_id, from_status: report.status, from_reason: report.status_reason, by: "person")
        (decision == "archive") ? report.set_status!("archived", "archived_by_person") : report.set_status!("active", nil)
      end
      redirect_to finance_settings_path(anchor: "settings-local-review"), status: :see_other, notice: t("billie.database.local.review_saved")
    end
  end
end
