module Finance
  class StatementsController < BaseController
    def index
      load_statement_lists
    end

    def create
      return import_batch if params.key?(:files)

      file = params[:file]
      header = file&.read(5)
      file&.rewind
      if header == "%PDF-" || File.extname(file&.original_filename.to_s).downcase == ".pdf"
        current_user.finance_statement_drafts.where("expires_at < ?", Time.current).delete_all
        draft = PdfStatementExtractor.new(user: current_user, file: file, currency: @profile.currency).call
        return import_pdf_automatically(draft) if draft.auto_importable?
        return redirect_to finance_statement_draft_path(draft), notice: "PDF extracted. Something looked unclear, so please review the highlighted items before importing."
      end
      importer = StatementImporter.new(user: current_user, file: params[:file], currency: @profile.currency, date_column: params[:date_column])
      statement = importer.call
      @profile.touch
      redirect_to finance_transactions_path, notice: "Imported #{statement.transaction_count} transactions from #{statement.filename}. Dates use the #{importer.date_column_used} column."
    rescue StatementImporter::ImportError => error
      load_statement_lists
      @date_columns = error.date_columns if error.is_a?(StatementImporter::DateColumnRequired)
      flash.now[:alert] = error.message
      render :index, status: :unprocessable_entity
    end

    def destroy
      statement = current_user.finance_statements.find(params[:id])
      statement.destroy!
      BalanceSync.call(user: current_user)
      @profile.touch
      redirect_to finance_statements_path, status: :see_other, notice: "Statement and its transactions deleted."
    end

    def update
      statement = current_user.finance_statements.find(params[:id])
      current_user.with_lock do
        account = if params[:bank_account_id].present?
          current_user.finance_bank_accounts.find(params[:bank_account_id])
        else
          details = params.require(:bank_account).permit(:bank_name, :name, :last4, :kind, :separate_account)
          unless details[:last4].to_s.match?(/\A\d{4}\z/) && details[:kind].in?(%w[cash credit]) &&
              details[:bank_name].to_s.strip.length.between?(1, 100) && details[:name].to_s.strip.length.between?(1, 100)
            raise StatementImporter::ImportError, "Enter the bank, account name, four-digit account ending, and cash or credit account type. No balance entry is needed."
          end
          identity = StatementAccountIdentity.from_details(bank_name: details[:bank_name], account_name: details[:name],
            account_last4: details[:last4], account_kind: details[:kind])
          identity[:account_name] = details[:name].strip
          identity[:account_key] = Digest::SHA256.hexdigest(SecureRandom.uuid) if details[:separate_account] == "1"
          BankAccount.resolve(user: current_user, identity: identity) ||
            raise(StatementImporter::ImportError, "The account details could not be identified. Check the bank name and last four digits.")
        end
        statement.update!(bank_account: account)
        BalanceSync.call(user: current_user)
      end
      redirect_to finance_statements_path(anchor: "statement-history"), status: :see_other,
        notice: "Account assigned. The automatic balance now uses each cash account’s latest statement."
    rescue StatementImporter::ImportError, ActiveRecord::RecordInvalid => error
      load_statement_lists
      flash.now[:alert] = error.is_a?(ActiveRecord::RecordInvalid) ? error.record.errors.full_messages.to_sentence : error.message
      render :index, status: :unprocessable_entity
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

    private

    def load_statement_lists
      load_account_balances
      @statements = current_user.finance_statements.includes(:bank_account).order(created_at: :desc)
      @pending_drafts = current_user.finance_statement_drafts.active.order(created_at: :desc)
    end

    def import_batch
      @import_results = BatchStatementImport.new(user: current_user, files: params[:files],
        currency: @profile.currency, date_column: params[:date_column]).call
      @profile.touch if @import_results.any? { |result| result[:status] == "imported" }
      load_statement_lists
      accepted = @import_results.any? { |result| result[:status] != "failed" }
      render :index, status: accepted ? :ok : :unprocessable_entity
    end

    # Nothing in the PDF needed a person's attention, so import it straight away.
    # Keep the draft for review if the import itself is refused (for example, a duplicate).
    def import_pdf_automatically(draft)
      statement = DraftImport.new(user: current_user, draft: draft).call
      @profile.touch
      redirect_to finance_transactions_path, notice: "Imported #{statement.transaction_count} transactions from #{statement.filename} automatically. Compare the count with your statement; if it looks wrong, delete it from Statement history and upload again."
    rescue StatementImporter::ImportError => error
      redirect_to finance_statement_draft_path(draft), alert: error.message
    end
  end
end
