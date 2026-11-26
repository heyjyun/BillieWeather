module Finance
  # Budgets (预算): a monthly or yearly limit for all spending, one category (with its subcategories)
  # or one project. Progress counts spending net of refunds; 90% (by default) shows a warning.
  class BudgetsController < BaseController
    def index
      @tree = CategoryTree.new(current_user)
      @projects = current_user.finance_projects.active.ordered.to_a
      @budgets = current_user.finance_budgets.includes(:project).order(:period, :category, :id).to_a
      @month_start = Book.default_for(current_user).month_start_day
      @on = if params[:on].present?
        begin
          Date.iso8601(params[:on])
        rescue
          finance_today
        end
      else
        finance_today
      end
      @statuses = @budgets.to_h { |budget| [budget.id, status_for(budget)] }
    end

    def create
      budget = current_user.finance_budgets.new(budget_params)
      if budget.save
        audit!("create", budget, {}, audit_values(budget, %w[period category project_id amount alert_percent]), summary: budget.scope_label || "total")
        redirect_to finance_budgets_path, notice: I18n.t("billie.ledger.budgets.saved")
      else
        redirect_to finance_budgets_path, alert: budget.errors.full_messages.to_sentence
      end
    end

    def update
      budget = current_user.finance_budgets.find(params[:id])
      before = audit_values(budget, %w[period category project_id amount alert_percent])
      if budget.update(budget_params.slice(:amount, :alert_percent, :period))
        audit!("update", budget, before, audit_values(budget, %w[period category project_id amount alert_percent]), summary: budget.scope_label || "total")
        redirect_to finance_budgets_path, notice: I18n.t("billie.ledger.budgets.saved")
      else
        redirect_to finance_budgets_path, alert: budget.errors.full_messages.to_sentence
      end
    end

    def destroy
      budget = current_user.finance_budgets.find(params[:id])
      before = audit_values(budget, %w[period category project_id amount alert_percent])
      budget.destroy!
      audit!("delete", budget, before, {}, summary: budget.scope_label || "total")
      redirect_to finance_budgets_path, notice: I18n.t("billie.ledger.budgets.deleted")
    end

    private

    def budget_params
      permitted = params.require(:budget).permit(:period, :scope, :amount, :alert_percent).to_h.symbolize_keys
      scope = permitted.delete(:scope).to_s
      permitted[:amount] = permitted[:amount].to_s.delete(",") if permitted.key?(:amount)
      if scope.start_with?("category:")
        permitted[:category] = scope.delete_prefix("category:")
      elsif scope.start_with?("project:")
        permitted[:project_id] = current_user.finance_projects.find(scope.delete_prefix("project:")).id
      end
      permitted
    end

    def status_for(budget)
      from, to = Domain.period_bounds(@on, budget.period, @month_start)
      scope = Transaction.included.expense_kind.where(user_id: current_user.id, booked_on: from..to)
      scope = scope.where(category: @tree.with_children(budget.category)) if budget.category.present?
      scope = scope.where(project_id: budget.project_id) if budget.project_id
      Domain.budget_status(-scope.sum(:amount), budget.amount, budget.alert_percent).merge(from: from, to: to)
    end
  end
end
