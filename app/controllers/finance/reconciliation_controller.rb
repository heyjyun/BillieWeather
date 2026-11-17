module Finance
  # Reconciliation Center: receipts awaiting review, matched and unmatched records, discrepancies,
  # recently verified matches and statement balance checks (Finance::ReconciliationReport, read-only).
  class ReconciliationController < BaseController
    def show
      @report = ReconciliationReport.new(current_user, today: finance_today)
      @suspect_income = @report.suspect_income_count
      @duplicate_rows = current_user.finance_transaction_links.suggested.where(link_type: "duplicate_of").joins(:from_transaction)
        .where(finance_transactions: {deleted_at: nil, superseded_by_id: nil}).count
    end
  end
end
