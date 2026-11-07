module Finance
  class TransactionsController < BaseController
    before_action :load_transaction, only: [:edit, :update]

    def index
      @categories = Transaction::CATEGORIES
      @filters = params.permit(:search, :category, :kind).to_h
      scope = current_user.finance_transactions.includes(:statement).order(booked_on: :desc, id: :desc)
      if @filters["search"].present?
        scope = scope.where("description ILIKE ?", "%#{Transaction.sanitize_sql_like(@filters['search'].to_s.first(200))}%")
      end
      scope = scope.where(category: @filters["category"]) if @categories.include?(@filters["category"])
      case @filters["kind"]
      when "income" then scope = scope.where("amount > 0")
      when "expense" then scope = scope.where("amount < 0")
      when "review" then scope = scope.where(tax_review: true)
      when "excluded" then scope = scope.where(excluded: true)
      end
      @total_count = scope.count
      @total_pages = [(@total_count / 50.0).ceil, 1].max
      @page = params[:page].to_i.clamp(1, @total_pages)
      respond_to do |format|
        format.html { @transactions = scope.offset((@page - 1) * 50).limit(50) }
        format.csv { export_csv(scope) }
      end
    end

    def edit
      @categories = Transaction::CATEGORIES
    end

    def update
      @categories = Transaction::CATEGORIES
      if @transaction.update(params.require(:finance_transaction).permit(:description, :category, :tax_review, :excluded))
        @profile.touch
        redirect_to finance_transactions_path, notice: "Transaction updated. Your totals and forecast now reflect this change."
      else
        render :edit, status: :unprocessable_entity
      end
    end

    private

    def load_transaction
      @transaction = current_user.finance_transactions.find(params[:id])
    end

    def export_csv(scope)
      require "csv"
      csv = CSV.generate do |rows|
        rows << ["Date", "Description", "Amount", "Currency", "Category", "Tax review", "Excluded"]
        scope.find_each do |transaction|
          rows << [transaction.booked_on.iso8601, csv_safe(transaction.description), transaction.amount.to_s("F"),
            transaction.statement.currency, transaction.category, transaction.tax_review, transaction.excluded]
        end
      end
      send_data csv, type: "text/csv; charset=utf-8", disposition: "attachment", filename: "billieweather-transactions-#{Date.current.iso8601}.csv"
    end

    def csv_safe(value)
      value.to_s.match?(/\A[\s]*[=+\-@\t\r]/) ? "'#{value}" : value
    end
  end
end
