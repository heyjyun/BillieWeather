module Finance
  class StatementDraftsController < BaseController
    before_action :load_draft

    def show
      render "finance/statements/review"
    end

    def destroy
      @draft.destroy!
      redirect_to finance_statements_path, status: :see_other, notice: I18n.t("billie.backend.pdf_discarded")
    end

    def confirm
      return review_error(I18n.t("billie.backend.pdf_review_confirm")) unless params[:review_confirmed] == "1"
      raw_rows = params[:rows]
      return review_error(I18n.t("billie.backend.no_rows_submitted")) unless raw_rows.is_a?(ActionController::Parameters)
      return review_error(I18n.t("billie.backend.pdf_row_limit")) if raw_rows.keys.length > 500
      return review_error(I18n.t("billie.backend.invalid_submitted_rows")) unless raw_rows.values.all? { |row| row.is_a?(ActionController::Parameters) }

      rows = raw_rows.values.map { |row| row.permit(:booked_on, :description, :amount, :include).to_h }
      @draft.rows = rows
      included_rows = rows.select { |row| row["include"] == "1" }
      return review_error(I18n.t("billie.backend.select_transaction")) if included_rows.empty?

      statement = DraftImport.new(user: current_user, draft: @draft, rows: rows).call
      @profile.touch
      redirect_to finance_transactions_path, notice: I18n.t("billie.backend.pdf_review_imported", count: statement.transaction_count)
    rescue StatementImporter::ImportError => error
      review_error(error.message)
    end

    private

    def load_draft
      @draft = current_user.finance_statement_drafts.find(params[:id])
      if @draft.expired?
        @draft.destroy!
        redirect_to finance_statements_path, alert: I18n.t("billie.backend.pdf_review_expired")
      end
    end

    def review_error(message)
      flash.now[:alert] = message
      render "finance/statements/review", status: :unprocessable_entity
    end
  end
end
