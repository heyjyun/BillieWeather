module Finance
  class TransactionsController < BaseController
    KIND_FILTERS = %w[income expense refund transfer card_payment adjustment manual review excluded].freeze

    before_action :load_transaction, only: [:edit, :update]

    def index
      @category_tree = CategoryTree.new(current_user)
      @accounts = current_user.finance_bank_accounts.ordered.to_a
      @merchants = current_user.finance_merchants.ordered.to_a
      @projects = current_user.finance_projects.ordered.to_a
      @tags = current_user.finance_tags.ordered.to_a
      @filters = params.permit(:search, :category, :currency, :activity, :kind, :start_date, :end_date, :account_id, :merchant_id, :project_id, :tag_id).to_h
      post_auto_recurring
      scope = current_user.finance_transactions.live.includes(:statement, :bank_account, :merchant, :project, :tags).order(booked_on: :desc, id: :desc)
      scope = OverviewData.in_currency(scope, @filters["currency"], @profile.currency) if @filters["currency"].present?
      case @filters["activity"]
      when "income" then scope = scope.included.income_kind
      when "spending" then scope = scope.included.expense_kind
      when "counted" then scope = scope.included
      end
      if params[:start_date].present? || params[:end_date].present?
        begin
          @date_range = DashboardPeriod.new(preset: "custom", start_date: params[:start_date], end_date: params[:end_date])
          scope = scope.where(booked_on: @date_range.start_date..@date_range.end_date)
        rescue DashboardPeriod::InvalidPeriod => error
          @date_filter_error = error.message
          scope = scope.none
        end
      end
      if @filters["search"].present?
        term = "%#{Transaction.sanitize_sql_like(@filters["search"].to_s.first(200))}%"
        scope = scope.where("description ILIKE :term OR original_description ILIKE :term OR note ILIKE :term", term: term)
      end
      # A category means itself plus all its descendants (docs/architecture/category-hierarchy.md).
      scope = scope.where(category: @category_tree.subtree(@filters["category"])) if @filters["category"].present? && (@category_tree.include?(@filters["category"]) || @filters["category"] == Transaction::UNCATEGORIZED)
      scope = scope.where(bank_account_id: @filters["account_id"]) if @accounts.any? { |a| a.id.to_s == @filters["account_id"] }
      scope = scope.where(merchant_id: @filters["merchant_id"]) if @merchants.any? { |m| m.id.to_s == @filters["merchant_id"] }
      scope = scope.where(project_id: @filters["project_id"]) if @projects.any? { |p| p.id.to_s == @filters["project_id"] }
      scope = scope.where(id: TransactionTag.where(tag_id: @filters["tag_id"]).select(:transaction_id)) if @tags.any? { |t| t.id.to_s == @filters["tag_id"] }
      # Income and expense follow the kind (a refund or a card repayment is not income).
      case @filters["kind"]
      when "income" then scope = scope.income_kind
      when "expense" then scope = scope.where(kind: "expense")
      when "refund", "transfer", "card_payment", "adjustment" then scope = scope.where(kind: @filters["kind"])
      when "manual" then scope = scope.where(entry_origin: %w[manual recurring])
      when "review" then scope = scope.where(tax_review: true)
      when "excluded" then scope = scope.where(excluded: true)
      end
      @total_count = scope.count
      @total_pages = [(@total_count / 50.0).ceil, 1].max
      @page = params[:page].to_i.clamp(1, @total_pages)
      @manual_tools = manual_mode? || params[:tools] == "manual"
      @review_counts = @manual_tools ? ledger_review_counts : {}
      respond_to do |format|
        format.html do
          @transactions = scope.offset((@page - 1) * 50).limit(50)
          render :index, status: @date_filter_error ? :unprocessable_entity : :ok
        end
        format.csv do
          if @date_filter_error
            render plain: @date_filter_error, status: :unprocessable_entity
          else
            export_csv(scope)
          end
        end
      end
    end

    def edit
      @category_tree = CategoryTree.new(current_user)
    end

    # Display fields of any entry (description, category, flags, merchant, project, tags, note). The
    # original description, and for imported rows the amount, date and account, never change here.
    def update
      @category_tree = CategoryTree.new(current_user)
      attributes = params.require(:finance_transaction).permit(:description, :category, :tax_review, :excluded, :note, :merchant_name, :project_id, :tag_names).to_h.symbolize_keys
      if attributes.key?(:description) && attributes[:description].to_s.strip.empty?
        @transaction.errors.add(:description, :blank)
        return render :edit, status: :unprocessable_entity
      end
      category_before = @transaction.category
      ledger.update(@transaction, attributes)
      @transaction.reload
      redirect_to finance_transactions_path, notice: update_notice(category_before)
    rescue Ledger::Invalid => error
      @transaction.reload
      @transaction.errors.add(:base, ledger_errors(error.codes))
      render :edit, status: :unprocessable_entity
    end

    # One change for every selected entry (category, project, merchant, tag, delete), audited as one batch.
    def batch
      ids = Array(params[:ids]).map(&:to_i)
      count = ledger.batch(ids, {action: params[:batch_action].to_s, value: params[:value]})
      redirect_back fallback_location: finance_transactions_path, notice: I18n.t("billie.ledger.batch.done", count: count)
    rescue Ledger::Invalid, ActiveRecord::RecordNotFound => error
      redirect_back fallback_location: finance_transactions_path, alert: ledger_errors(error.respond_to?(:codes) ? error.codes : "not_found")
    end

    private

    # When the category changed, remember it for this merchant so future imports (and
    # other Uncategorized rows from the same merchant) are filed the same way.
    def update_notice(category_before)
      notice = I18n.t("billie.backend.transaction_updated")
      return notice if category_before == @transaction.category

      source = @transaction.original_description.presence || @transaction.description
      similar = MerchantRule.remember!(user: current_user, description: source, amount: @transaction.amount, category: @transaction.category)
      return notice if similar.nil?

      merchant = Categorizer.merchant_key(source).titleize
      notice + I18n.t("billie.backend.merchant_remembered", merchant: merchant, category: DefaultCategories.label(@transaction.category)) + ((similar > 0) ? I18n.t("billie.backend.similar_updated", count: similar) : ".")
    end

    def load_transaction
      @transaction = current_user.finance_transactions.live.find(params[:id])
    end

    # Recurring rules the person set to post automatically are posted when the list opens.
    def post_auto_recurring
      rules = current_user.finance_recurring_rules.where(auto_post: true, paused: false).to_a
      return if rules.empty?
      result = RecurringPoster.call(user: current_user, today: finance_today, rules: rules)
      flash.now[:notice] = I18n.t("billie.ledger.recurring.posted", count: result[:posted]) if result[:posted].positive?
    end

    # The Transactions page keeps its original columns so existing spreadsheets and scripts still work.
    # The fuller report CSV (account, merchant, byte-order mark) lives in Finance::ReportsController.
    def export_csv(scope)
      require "csv"
      currency = @profile.currency
      csv = CSV.generate do |rows|
        rows << ["Date", "Description", "Amount", "Currency", "Category", "Tax review", "Excluded"]
        scope.find_each do |transaction|
          rows << [transaction.booked_on.iso8601, TransactionCsv.safe_text(transaction.description), transaction.amount.to_s("F"),
            transaction.statement&.currency || transaction.bank_account&.currency || currency, TransactionCsv.safe_text(transaction.category), transaction.tax_review, transaction.excluded]
        end
      end
      send_data csv, type: "text/csv; charset=utf-8", disposition: "attachment", filename: "billieweather-transactions-#{Date.current.iso8601}.csv"
    end
  end
end
