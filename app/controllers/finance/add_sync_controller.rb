module Finance
  # Transactions › Add & Sync: one place for every way to bring transactions in. It links to the
  # existing tools (statement import, receipts, manual entry); it adds no new ingestion path. Connect
  # Financial Accounts is shown as Coming soon: there is no bank connection in BillieWeather.
  class AddSyncController < BaseController
    def show
      @statement_count = current_user.finance_statements.count
      @open_receipts = current_user.finance_receipts.where(status: Receipt::OPEN_STATUSES).count
    end
  end
end
