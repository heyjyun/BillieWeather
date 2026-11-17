module Finance
  # Receipt-only tokens for iOS Shortcuts ("Hey Siri, scan a receipt with BillieWeather"). The token is
  # shown once, right after it is created, and only its digest is stored.
  class CaptureTokensController < BaseController
    def create
      record, @new_token = CaptureToken.issue!(user: current_user, name: params.dig(:capture_token, :name).presence || t("billie.receipts.shortcuts.default_name"))
      AuditEvent.record!(user: current_user, action: "create", subject: record, summary: record.name, changes: {"before" => {}, "after" => {"name" => record.name, "token_prefix" => record.token_prefix}})
      @new_token_record = record
      @receipts = current_user.finance_receipts.visible.newest_first.includes(:entry, :matches).limit(60).to_a
      @statements = current_user.finance_statements.order(created_at: :desc).limit(5).to_a
      @tokens = current_user.finance_capture_tokens.order(created_at: :desc).to_a
      @local_ocr = LocalOcr.available?
      response.headers["Cache-Control"] = "no-store"
      render "finance/receipts/index", status: :created
    rescue ActiveRecord::RecordInvalid
      redirect_to finance_receipts_path(anchor: "shortcuts"), alert: t("billie.receipts.shortcuts.too_many", count: CaptureToken::MAX_ACTIVE)
    end

    def destroy
      record = current_user.finance_capture_tokens.find(params[:id])
      record.revoke! if record.active?
      AuditEvent.record!(user: current_user, action: "archive", subject: record, summary: record.name, changes: {"before" => {"revoked_at" => nil}, "after" => {"revoked_at" => record.revoked_at&.iso8601}})
      redirect_to finance_receipts_path(anchor: "shortcuts"), notice: t("billie.receipts.shortcuts.revoked")
    end
  end
end
