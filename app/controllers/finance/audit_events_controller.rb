module Finance
  # Operation log (操作日志): every change to accounts, entries, categories, dimensions, budgets and
  # recurring rules, newest first, filterable by action and subject. Batches (batch edits, AI) can be undone.
  class AuditEventsController < BaseController

    def index
      scope = current_user.finance_audit_events.newest_first
      @filters = params.permit(:action_type, :subject).to_h
      scope = scope.where(action: @filters["action_type"]) if Domain::AUDIT_ACTIONS.include?(@filters["action_type"])
      scope = scope.where(subject_type: @filters["subject"]) if @filters["subject"].present?
      @subjects = current_user.finance_audit_events.distinct.order(:subject_type).pluck(:subject_type)
      @events = scope.limit(300).to_a
    end

    def undo
      result = ledger.undo_batch(params[:batch_id])
      redirect_to finance_activity_path, notice: I18n.t("billie.ledger.activity.undone", count: result[:undone], skipped: result[:skipped])
    rescue Ledger::Invalid => error
      redirect_to finance_activity_path, alert: ledger_errors(error.codes)
    end
  end
end
