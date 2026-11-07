module Finance
  class StatementsController < BaseController
    def index
      @statements = current_user.finance_statements.order(created_at: :desc)
    end

    def create
      file = params[:file]
      header = file&.read(5)
      file&.rewind
      if header == "%PDF-" || File.extname(file&.original_filename.to_s).downcase == ".pdf"
        current_user.finance_statement_drafts.where("expires_at < ?", Time.current).delete_all
        draft = PdfStatementExtractor.new(user: current_user, file: file, currency: @profile.currency,
          year: params.fetch(:statement_year, Date.current.year)).call
        return redirect_to finance_statement_draft_path(draft), notice: "PDF extracted. Review every date and signed amount before importing."
      end
      statement = StatementImporter.new(user: current_user, file: params[:file], currency: @profile.currency).call
      @profile.touch
      redirect_to finance_transactions_path, notice: "Imported #{statement.transaction_count} transactions from #{statement.filename}."
    rescue StatementImporter::ImportError => error
      @statements = current_user.finance_statements.order(created_at: :desc)
      flash.now[:alert] = error.message
      render :index, status: :unprocessable_entity
    end

    def destroy
      statement = current_user.finance_statements.find(params[:id])
      statement.destroy!
      @profile.touch
      redirect_to finance_statements_path, status: :see_other, notice: "Statement and its transactions deleted."
    end

    def sample
      require "csv"
      today = Date.current
      csv = CSV.generate do |rows|
        rows << ["Date", "Description", "Amount", "Currency"]
        rows << [(today - 29).iso8601, "Salary deposit", "4200.00", @profile.currency]
        rows << [(today - 27).iso8601, "Rent payment", "-1400.00", @profile.currency]
        rows << [(today - 21).iso8601, "Grocery market", "-86.35", @profile.currency]
        rows << [(today - 15).iso8601, "Internet bill", "-65.00", @profile.currency]
        rows << [(today - 7).iso8601, "Office supplies", "-42.50", @profile.currency]
        rows << [today.iso8601, "Coffee shop", "-6.25", @profile.currency]
      end
      send_data csv, type: "text/csv; charset=utf-8", disposition: "attachment", filename: "billieweather-sample.csv"
    end
  end
end
