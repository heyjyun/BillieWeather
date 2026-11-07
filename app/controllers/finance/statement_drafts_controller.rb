require "csv"
require "stringio"

module Finance
  class StatementDraftsController < BaseController
    before_action :load_draft

    def show
      render "finance/statements/review"
    end

    def destroy
      @draft.destroy!
      redirect_to finance_statements_path, status: :see_other, notice: "PDF draft discarded. No transactions were imported."
    end

    def confirm
      return review_error("Confirm that you checked the extracted transactions against your PDF.") unless params[:review_confirmed] == "1"
      raw_rows = params[:rows]
      return review_error("No transaction rows were submitted.") unless raw_rows.is_a?(ActionController::Parameters)
      return review_error("A PDF import can contain at most 500 rows.") if raw_rows.keys.length > 500
      return review_error("The submitted transaction rows are invalid.") unless raw_rows.values.all? { |row| row.is_a?(ActionController::Parameters) }

      rows = raw_rows.values.map { |row| row.permit(:booked_on, :description, :amount, :include).to_h }
      @draft.rows = rows
      included_rows = rows.select { |row| row["include"] == "1" }
      return review_error("Select at least one transaction to import.") if included_rows.empty?

      csv = CSV.generate do |output|
        output << ["Date", "Description", "Amount", "Currency"]
        included_rows.each { |row| output << [row["booked_on"], row["description"], row["amount"], @draft.currency] }
      end
      stream = StringIO.new(csv)
      stream.define_singleton_method(:original_filename) { "reviewed-transactions.csv" }
      statement = StatementImporter.new(user: current_user, file: stream, currency: @draft.currency,
        source_sha256: @draft.sha256, source_filename: @draft.filename).call
      @draft.destroy!
      @profile.touch
      redirect_to finance_transactions_path, notice: "Imported #{statement.transaction_count} reviewed PDF transactions."
    rescue StatementImporter::ImportError => error
      review_error(error.message)
    end

    private

    def load_draft
      @draft = current_user.finance_statement_drafts.find(params[:id])
      if @draft.expired?
        @draft.destroy!
        redirect_to finance_statements_path, alert: "This PDF review expired. Upload the file again to start a new review."
      end
    end

    def review_error(message)
      flash.now[:alert] = message
      render "finance/statements/review", status: :unprocessable_entity
    end
  end
end
