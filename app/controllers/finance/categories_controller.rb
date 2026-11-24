module Finance
  # Category details: every category (built-in and the person's own) with its totals, the
  # transactions in the selected one, adding/renaming/deleting custom categories, and the
  # one-click "Categorize with AI" for Uncategorized transactions.
  class CategoriesController < BaseController
    DETAIL_LIMIT = 100

    def index
      load_page
    end

    def create
      category = current_user.finance_custom_categories.new(name: params.dig(:category, :name))
      if category.save
        redirect_to finance_categories_path(name: category.name), notice: I18n.t("billie.categories.created", name: category.name)
      else
        fail_with(category)
      end
    end

    def update
      category = current_user.finance_custom_categories.find(params[:id])
      old_name = category.name
      if category.rename!(params.dig(:category, :name))
        redirect_to finance_categories_path(name: category.name), notice: I18n.t("billie.categories.renamed", old: old_name, name: category.name)
      else
        fail_with(category)
      end
    end

    # Deletes a custom category. With move_to (another category) this is a merge: entries and remembered
    # rules move there. Without it, entries become Uncategorized (the original behaviour).
    def destroy
      category = current_user.finance_custom_categories.find(params[:id])
      target = params[:move_to].presence
      return redirect_to(finance_categories_path, alert: I18n.t("billie.ledger.errors.category_unknown")) if target && !CustomCategory.valid_for?(current_user, target)
      moved = category.remove!(move_to: target || "Uncategorized")
      AuditEvent.record!(user: current_user, action: target ? "merge" : "delete", subject: ["Category", category.name], summary: category.name,
        changes: {"before" => {"name" => category.name}, "after" => {"moved_to" => target || "Uncategorized", "entries" => moved}})
      notice = target ? I18n.t("billie.ledger.categories.merged", name: category.name, into: target, count: moved) : I18n.t("billie.categories.deleted", name: category.name, count: moved)
      redirect_to finance_categories_path, notice: notice
    end

    # Where a category sits: parent (two levels at most), income or expense tree, order, hidden.
    def arrange
      name = params[:name].to_s
      return head(:not_found) unless CustomCategory.valid_for?(current_user, name) && !CategoryTree::SPECIAL.include?(name)
      setting = current_user.finance_category_settings.where("lower(name) = ?", name.downcase).first_or_initialize(name: name)
      before = setting.persisted? ? setting.attributes.slice("parent_name", "category_kind", "sort_order", "hidden") : {}
      custom = !Transaction::CATEGORIES.include?(name)
      attrs = params.fetch(:arrangement, {}).permit(:parent_name, :category_kind, :sort_order, :hidden).to_h
      setting.parent_name = attrs["parent_name"].presence if custom && attrs.key?("parent_name")
      setting.category_kind = custom ? (attrs["category_kind"].presence_in(Domain::CATEGORY_KINDS) || setting.category_kind || "expense") : ((name == "Income") ? "income" : "expense")
      setting.sort_order = attrs["sort_order"].to_i if attrs.key?("sort_order")
      setting.hidden = ActiveModel::Type::Boolean.new.cast(attrs["hidden"]) || false if attrs.key?("hidden")
      if setting.parent_name.present? && (!CustomCategory.valid_for?(current_user, setting.parent_name) || CategoryTree::SPECIAL.include?(setting.parent_name) ||
          CategoryTree.new(current_user).kind_of(setting.parent_name) != setting.category_kind)
        return redirect_to(finance_categories_path(name: name), alert: I18n.t("billie.ledger.errors.parent_invalid"))
      end
      if setting.save
        AuditEvent.record!(user: current_user, action: "update", subject: ["Category", name], summary: name,
          changes: {"before" => before, "after" => setting.attributes.slice("parent_name", "category_kind", "sort_order", "hidden")})
        redirect_to finance_categories_path(name: name), notice: I18n.t("billie.ledger.categories.arranged", name: name)
      else
        redirect_to finance_categories_path(name: name), alert: I18n.t("billie.ledger.errors.parent_invalid")
      end
    end

    def ai_categorize
      result = AiCategorizer.new(user: current_user, consent: params[:consent] == "1").call
      notice = I18n.t("billie.categories.ai_done", count: result.updated, sent: result.sent)
      notice += " " + I18n.t("billie.categories.ai_remaining", count: result.remaining) if result.remaining.positive?
      # The run is one audited batch; the page offers to undo it right away (operation log has it too).
      flash[:ai_batch_id] = result.batch_id if result.batch_id
      redirect_to finance_categories_path(name: params[:name].presence), notice: notice
    rescue AiCategorizer::Error => error
      load_page
      flash.now[:alert] = error.message
      render :index, status: (error.code == :wait) ? :too_many_requests : :unprocessable_entity
    end

    private

    def fail_with(category)
      load_page
      flash.now[:alert] = error_message(category)
      render :index, status: :unprocessable_entity
    end

    def error_message(category)
      return I18n.t("billie.categories.errors.too_many", count: CustomCategory::MAX_PER_USER) if category.errors.of_kind?(:base, :too_many)
      return I18n.t("billie.categories.errors.blank") if category.errors.of_kind?(:name, :blank)
      return I18n.t("billie.categories.errors.too_long", count: CustomCategory::MAX_LENGTH) if category.errors.of_kind?(:name, :too_long)
      return I18n.t("billie.categories.errors.reserved") if category.errors.of_kind?(:name, :reserved)
      I18n.t("billie.categories.errors.taken")
    end

    def load_page
      @custom_categories = current_user.finance_custom_categories.order(Arel.sql("lower(name)")).to_a
      names = Transaction::CATEGORIES + @custom_categories.map(&:name)
      # Spending by kind: expenses minus refunds; income only from income entries (not refunds or repayments).
      stats = current_user.finance_transactions.live.group(:category).pluck(
        :category, Arel.sql("COUNT(*)"),
        Arel.sql("COALESCE(SUM(CASE WHEN kind IN ('expense', 'refund') AND NOT excluded THEN -amount ELSE 0 END), 0)"),
        Arel.sql("COALESCE(SUM(CASE WHEN kind = 'income' AND NOT excluded THEN amount ELSE 0 END), 0)"),
        Arel.sql("MAX(booked_on)")
      ).to_h { |name, count, spent, received, last| [name, {count: count, spent: spent, received: received, last_on: last}] }
      counted_spending = stats.except("Transfers").sum { |_name, row| row[:spent] }
      custom_by_name = @custom_categories.index_by(&:name)
      @category_rows = names.map do |name|
        row = stats.fetch(name, {count: 0, spent: 0, received: 0, last_on: nil})
        share = (name != "Transfers" && counted_spending.positive? && row[:spent].positive?) ? (row[:spent] / counted_spending) : nil
        row.merge(name: name, custom: custom_by_name[name], share: share)
      end
      @uncategorized_count = stats.dig("Uncategorized", :count).to_i
      breakdown = SpendingBreakdown.new(user: current_user)
      @spending_mix = breakdown.mix
      @spending_monthly = breakdown.monthly
      @spending_tones = names.to_h { |name| [name, breakdown.tone(name)] }
      @selected = names.include?(params[:name]) ? params[:name] : nil
      if @selected
        @selected_tone = breakdown.tone(@selected)
        @selected_trend = breakdown.trend(@selected)
        @selected_merchants = breakdown.top_merchants(@selected)
        scope = current_user.finance_transactions.live.where(category: @selected)
        @selected_row = @category_rows.find { |row| row[:name] == @selected }
        @selected_transactions = scope.includes(:statement).recent_first.limit(DETAIL_LIMIT).to_a
      end
      @ai_available = AiCategorizer.available?
      @tree = CategoryTree.new(current_user)
    end
  end
end
