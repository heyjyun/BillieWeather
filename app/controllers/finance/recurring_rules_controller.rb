module Finance
  # Recurring entries (周期记账): a template (any manual kind) plus a schedule. Due entries are posted
  # when the person presses "Post due entries" (or automatically for rules with auto-post when the
  # Transactions page opens); each date is posted once.
  class RecurringRulesController < BaseController
    include ManualWorkspace

    before_action :load_rule, only: [:edit, :update, :destroy, :toggle]
    before_action :load_form_data, only: [:new, :create, :edit, :update]

    def index
      @rules = current_user.finance_recurring_rules.order(:paused, :next_on, :name).to_a
      @due = @rules.sum { |rule| rule.due_dates(finance_today).count { |date| !current_user.finance_transactions.where(recurring_rule_id: rule.id, recurring_on: date).exists? } }
    end

    def new
      @rule = current_user.finance_recurring_rules.new(frequency: "monthly", interval: 1, start_on: finance_today, template: {"kind" => "expense"})
    end

    def create
      @rule = current_user.finance_recurring_rules.new(rule_params)
      if valid_template?(@rule) && @rule.save
        audit!("create", @rule, {}, audit_values(@rule, %w[name template frequency interval start_on end_on auto_post paused]))
        redirect_to finance_recurring_rules_path, notice: I18n.t("billie.ledger.recurring.saved", name: @rule.name)
      else
        render :new, status: :unprocessable_entity
      end
    end

    def edit
    end

    def update
      before = audit_values(@rule, %w[name template frequency interval start_on end_on auto_post paused])
      @rule.assign_attributes(rule_params)
      @rule.next_on = @rule.start_on if @rule.start_on_changed? && !current_user.finance_transactions.where(recurring_rule_id: @rule.id).exists?
      if valid_template?(@rule) && @rule.save
        audit!("update", @rule, before, audit_values(@rule, %w[name template frequency interval start_on end_on auto_post paused]))
        redirect_to finance_recurring_rules_path, notice: I18n.t("billie.ledger.recurring.saved", name: @rule.name)
      else
        render :edit, status: :unprocessable_entity
      end
    end

    def toggle
      before = {"paused" => @rule.paused}
      @rule.update!(paused: !@rule.paused)
      audit!("update", @rule, before, {"paused" => @rule.paused})
      redirect_to finance_recurring_rules_path
    end

    def destroy
      before = audit_values(@rule, %w[name template frequency interval start_on end_on])
      @rule.destroy!
      audit!("delete", @rule, before, {})
      redirect_to finance_recurring_rules_path, notice: I18n.t("billie.ledger.recurring.deleted", name: @rule.name)
    end

    def post_due
      result = RecurringPoster.call(user: current_user, today: finance_today)
      flash[:alert] = result[:failed].map { |name, codes| "#{name}: #{ledger_errors(codes)}" }.join(" ") if result[:failed].any?
      redirect_to finance_recurring_rules_path, notice: I18n.t("billie.ledger.recurring.posted", count: result[:posted])
    end

    private

    def load_rule
      @rule = current_user.finance_recurring_rules.find(params[:id])
    end

    def load_form_data
      @accounts = current_user.finance_bank_accounts.active.ordered.to_a
      @tree = CategoryTree.new(current_user)
      @projects = current_user.finance_projects.active.ordered.to_a
    end

    def rule_params
      permitted = params.require(:recurring_rule).permit(:name, :frequency, :interval, :start_on, :end_on, :auto_post,
        template: %i[kind amount account_id to_account_id category merchant_name project_id note description])
      template = permitted.delete(:template).to_h.compact_blank
      permitted.merge(template: template, end_on: permitted[:end_on].presence)
    end

    # The template must make a valid entry (same checks as the manual form), so posting cannot fail later.
    def valid_template?(rule)
      t = rule.template.symbolize_keys
      account = current_user.finance_bank_accounts.find_by(id: t[:account_id])
      to = current_user.finance_bank_accounts.find_by(id: t[:to_account_id])
      tree = CategoryTree.new(current_user)
      codes = Domain.entry_problems(kind: t[:kind].to_s, amount: t[:amount], occurred_on: rule.start_on || Date.current, account_id: account&.id,
        to_account_id: (t[:kind] == "transfer") ? to&.id : nil, category_kind: t[:category].present? ? tree.kind_of(t[:category]) : nil)
      codes << "kind_invalid" unless %w[expense income transfer].include?(t[:kind].to_s)
      return true if codes.empty?
      rule.errors.add(:base, ledger_errors(codes))
      false
    end
  end
end
