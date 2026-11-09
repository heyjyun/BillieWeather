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

    def destroy
      category = current_user.finance_custom_categories.find(params[:id])
      moved = category.remove!
      redirect_to finance_categories_path, notice: I18n.t("billie.categories.deleted", name: category.name, count: moved)
    end

    def ai_categorize
      result = AiCategorizer.new(user: current_user, consent: params[:consent] == "1").call
      notice = I18n.t("billie.categories.ai_done", count: result.updated, sent: result.sent)
      notice += " " + I18n.t("billie.categories.ai_remaining", count: result.remaining) if result.remaining.positive?
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
      stats = current_user.finance_transactions.group(:category).pluck(
        :category, Arel.sql("COUNT(*)"),
        Arel.sql("COALESCE(SUM(CASE WHEN amount < 0 AND NOT excluded THEN -amount ELSE 0 END), 0)"),
        Arel.sql("COALESCE(SUM(CASE WHEN amount > 0 AND NOT excluded THEN amount ELSE 0 END), 0)"),
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
      @selected = names.include?(params[:name]) ? params[:name] : nil
      if @selected
        scope = current_user.finance_transactions.where(category: @selected)
        @selected_row = @category_rows.find { |row| row[:name] == @selected }
        @selected_transactions = scope.includes(:statement).recent_first.limit(DETAIL_LIMIT).to_a
      end
      @ai_available = AiCategorizer.available?
    end
  end
end
