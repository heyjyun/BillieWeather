module Finance
  # The Categories page (docs/architecture/category-hierarchy.md): the person's category tree
  # (any depth, collapsed by default) with totals that roll up subcategories, adding a category under
  # any parent, renaming any category (defaults too), moving, reordering, hiding, deleting with a
  # destination, merging, "Add suggested categories", and the one-click "Categorize with AI" for
  # Uncategorized transactions (with the AI's proposed subcategories to approve or dismiss).
  class CategoriesController < BaseController
    DETAIL_LIMIT = 100

    before_action :load_category, only: [:update, :destroy, :move, :reorder, :expand, :merge]

    def index
      load_page
    end

    def create
      attrs = params.fetch(:category, {}).permit(:name, :parent_name, :category_kind)
      category = Category.create_for!(current_user, name: attrs[:name], parent: attrs[:parent_name].presence, kind: attrs[:category_kind])
      AuditEvent.record!(user: current_user, action: "create", subject: ["Category", category.name], summary: category.name,
        changes: {"before" => {}, "after" => {"name" => category.name, "parent" => category.parent&.name}})
      redirect_to finance_categories_path(name: category.name), notice: I18n.t("billie.categories.created", name: category.name)
    rescue ActiveRecord::RecordInvalid => error
      fail_with(error.record)
    end

    def update
      old_name = @category.name
      if @category.rename!(params.dig(:category, :name))
        AuditEvent.record!(user: current_user, action: "update", subject: ["Category", @category.name], summary: @category.name,
          changes: {"before" => {"name" => old_name}, "after" => {"name" => @category.name}}) if old_name != @category.name
        redirect_to finance_categories_path(name: @category.name), notice: I18n.t("billie.categories.renamed", old: old_name, name: @category.name)
      else
        fail_with(@category)
      end
    end

    # Deletes a category. Entries (and remembered rules) move to `move_to`, by default its parent, or
    # Uncategorized for a top-level category. Its subcategories move up to its parent.
    def destroy
      target = params[:move_to].presence
      name = @category.name
      moved = @category.remove!(move_to: target)
      destination = target || @category.parent&.name || Transaction::UNCATEGORIZED
      AuditEvent.record!(user: current_user, action: "delete", subject: ["Category", name], summary: name,
        changes: {"before" => {"name" => name}, "after" => {"moved_to" => destination, "entries" => moved}})
      notice = (destination == Transaction::UNCATEGORIZED) ? I18n.t("billie.categories.deleted", name: name, count: moved) :
        I18n.t("billie.categories.deleted_into", name: name, into: destination, count: moved)
      redirect_to finance_categories_path, notice: notice
    rescue Category::Invalid => error
      redirect_to finance_categories_path(name: @category.name), alert: category_error(error.code)
    end

    # Merges this category into another: like delete with that destination, and its subcategories
    # become the destination's subcategories.
    def merge
      target = Category.for_user(current_user).where("lower(name) = lower(?)", params[:into].to_s).first
      name = @category.name
      moved = @category.merge_into!(target)
      AuditEvent.record!(user: current_user, action: "merge", subject: ["Category", name], summary: name,
        changes: {"before" => {"name" => name}, "after" => {"moved_to" => target.name, "entries" => moved}})
      redirect_to finance_categories_path(name: target.name), notice: I18n.t("billie.ledger.categories.merged", name: name, into: target.name, count: moved)
    rescue Category::Invalid => error
      redirect_to finance_categories_path(name: @category.name), alert: category_error(error.code)
    end

    # Moves a category (with its subcategories) under another one, or to the top level.
    def move
      parent_name = params[:parent_name].presence
      parent = parent_name && Category.for_user(current_user).where("lower(name) = lower(?)", parent_name).first
      raise Category::Invalid, :parent_invalid if parent_name && parent.nil?
      before = {"parent" => @category.parent&.name, "kind" => @category.category_kind}
      @category.move_to!(parent)
      AuditEvent.record!(user: current_user, action: "update", subject: ["Category", @category.name], summary: @category.name,
        changes: {"before" => before, "after" => {"parent" => parent&.name, "kind" => @category.category_kind}})
      redirect_to finance_categories_path(name: @category.name), notice: I18n.t("billie.ledger.categories.arranged", name: @category.name)
    rescue Category::Invalid => error
      redirect_to finance_categories_path(name: @category.name), alert: category_error(error.code)
    end

    # One step up or down among its siblings.
    def reorder
      @category.reorder!((params[:direction] == "up") ? -1 : 1)
      redirect_to finance_categories_path(name: @category.name, anchor: "category-tree")
    end

    # Opening or closing a category's subcategories in the tree is remembered (default: closed).
    def expand
      # updated_at stays: expansion is a view preference and not part of what the apps sync.
      @category.update_columns(expanded: ActiveModel::Type::Boolean.new.cast(params[:expanded]) || false)
      respond_to do |format|
        format.json { head :no_content }
        format.html { redirect_to finance_categories_path(anchor: "category-tree") }
      end
    end

    # Where a category sits, from the details form: parent (any depth), kind (top-level only),
    # order among its siblings and the hidden flag.
    def arrange
      category = Category.for_user(current_user).where("lower(name) = lower(?)", params[:name].to_s).first
      return head(:not_found) unless category
      attrs = params.fetch(:arrangement, {}).permit(:parent_name, :category_kind, :sort_order, :hidden).to_h
      before = arrangement_of(category)
      Category.transaction do
        if attrs.key?("parent_name")
          parent = attrs["parent_name"].presence && Category.for_user(current_user).where("lower(name) = lower(?)", attrs["parent_name"]).first
          raise Category::Invalid, :parent_invalid if attrs["parent_name"].present? && parent.nil?
          category.move_to!(parent) if parent&.id != category.parent_id
        end
        if category.root? && !category.transfers_root? && attrs["category_kind"].present? && attrs["category_kind"] != category.category_kind
          category.change_kind!(attrs["category_kind"])
        end
        category.update!(sort_order: attrs["sort_order"].to_i.clamp(-999, 999)) if attrs.key?("sort_order")
        category.update!(hidden: ActiveModel::Type::Boolean.new.cast(attrs["hidden"]) || false) if attrs.key?("hidden")
      end
      Profile.where(user_id: current_user.id).touch_all
      AuditEvent.record!(user: current_user, action: "update", subject: ["Category", category.name], summary: category.name,
        changes: {"before" => before, "after" => arrangement_of(category.reload)})
      redirect_to finance_categories_path(name: category.name), notice: I18n.t("billie.ledger.categories.arranged", name: category.name)
    rescue Category::Invalid => error
      redirect_to finance_categories_path(name: category.name), alert: category_error(error.code)
    rescue ActiveRecord::RecordInvalid
      redirect_to finance_categories_path(name: category.name), alert: I18n.t("billie.ledger.errors.parent_invalid")
    end

    # Adds the default categories this person doesn't have yet (never renames, moves or duplicates).
    def add_suggested
      added = Category.add_suggested!(current_user)
      if added.any?
        AuditEvent.record!(user: current_user, action: "create", subject: ["Category", "suggested"], summary: I18n.t("billie.categories.suggested_summary"),
          changes: {"before" => {}, "after" => {"added" => added}})
      end
      redirect_to finance_categories_path(anchor: "category-tree"),
        notice: added.any? ? I18n.t("billie.categories.suggested_added", count: added.length) : I18n.t("billie.categories.suggested_none")
    end

    def ai_categorize
      result = AiCategorizer.new(user: current_user, consent: params[:consent] == "1").call
      notice = I18n.t("billie.categories.ai_done", count: result.updated, sent: result.sent)
      notice += " " + I18n.t("billie.categories.ai_remaining", count: result.remaining) if result.remaining.positive?
      notice += " " + I18n.t("billie.categories.proposals_waiting", count: result.proposals) if result.proposals.to_i.positive?
      # The run is one audited batch; the page offers to undo it right away (operation log has it too).
      flash[:ai_batch_id] = result.batch_id if result.batch_id
      redirect_to finance_categories_path(name: params[:name].presence), notice: notice
    rescue AiCategorizer::Error => error
      load_page
      flash.now[:alert] = error.message
      render :index, status: (error.code == :wait) ? :too_many_requests : :unprocessable_entity
    end

    private

    def load_category
      @category = Category.for_user(current_user).find(params[:id])
    end

    def arrangement_of(category)
      {"parent" => category.parent&.name, "kind" => category.category_kind, "sort_order" => category.sort_order, "hidden" => category.hidden}
    end

    def category_error(code)
      I18n.t("billie.categories.errors.#{code}", default: I18n.t("billie.ledger.errors.#{code}", default: I18n.t("billie.ledger.errors.generic")))
    end

    def fail_with(category)
      load_page
      flash.now[:alert] = error_message(category)
      render :index, status: :unprocessable_entity
    end

    def error_message(category)
      return I18n.t("billie.categories.errors.too_many", count: Category::MAX_PER_USER) if category.errors.of_kind?(:base, :too_many)
      return I18n.t("billie.categories.errors.blank") if category.errors.of_kind?(:name, :blank)
      return I18n.t("billie.categories.errors.too_long", count: Category::MAX_LENGTH) if category.errors.of_kind?(:name, :too_long)
      return I18n.t("billie.categories.errors.reserved") if category.errors.of_kind?(:name, :reserved)
      return I18n.t("billie.ledger.errors.parent_invalid") if category.errors.include?(:parent) || category.errors.include?(:category_kind)
      I18n.t("billie.categories.errors.taken")
    end

    def load_page
      @tree = CategoryTree.new(current_user)
      @category_records = Category.where(user_id: current_user.id).index_by(&:name)
      names = @tree.names
      # Spending by kind: expenses minus refunds; income only from income entries (not refunds or repayments).
      direct = current_user.finance_transactions.live.group(:category).pluck(
        :category, Arel.sql("COUNT(*)"),
        Arel.sql("COALESCE(SUM(CASE WHEN kind IN ('expense', 'refund') AND NOT excluded THEN -amount ELSE 0 END), 0)"),
        Arel.sql("COALESCE(SUM(CASE WHEN kind = 'income' AND NOT excluded THEN amount ELSE 0 END), 0)"),
        Arel.sql("MAX(booked_on)")
      ).to_h { |name, count, spent, received, last| [name, {count: count, spent: spent, received: received, last_on: last}] }
      # A category's totals are its own entries plus its descendants' (roll-up).
      stats = names.to_h do |name|
        rows = @tree.subtree(name).filter_map { |member| direct[member] }
        [name, {count: rows.sum { |row| row[:count] }, spent: rows.sum(BigDecimal(0)) { |row| row[:spent] },
                received: rows.sum(BigDecimal(0)) { |row| row[:received] }, last_on: rows.filter_map { |row| row[:last_on] }.max}]
      end
      @direct_stats = direct
      transfer_names = @tree.transfer_names.to_set
      counted_spending = direct.reject { |name, _row| transfer_names.include?(name) }.sum { |_name, row| row[:spent] }
      @category_rows = names.map do |name|
        row = stats.fetch(name)
        share = (!transfer_names.include?(name) && counted_spending.positive? && row[:spent].positive?) ? (row[:spent] / counted_spending) : nil
        node = @tree.node(name)
        row.merge(name: name, record: @category_records[name], custom: node && node.key.nil?, depth: node&.depth || 0, share: share)
      end
      @uncategorized_count = direct.dig(Transaction::UNCATEGORIZED, :count).to_i
      breakdown = SpendingBreakdown.new(user: current_user)
      @spending_mix = breakdown.mix
      @spending_monthly = breakdown.monthly
      @spending_tones = names.to_h { |name| [name, breakdown.tone(@tree.root_of(name))] }
      @selected = @tree.include?(params[:name]) ? params[:name] : nil
      if @selected
        @selected_record = @category_records[@selected]
        @selected_tone = breakdown.tone(@tree.root_of(@selected))
        @selected_trend = breakdown.trend(@selected)
        @selected_merchants = breakdown.top_merchants(@selected)
        scope = current_user.finance_transactions.live.where(category: @tree.subtree(@selected))
        @selected_row = @category_rows.find { |row| row[:name] == @selected }
        @selected_transactions = scope.includes(:statement).recent_first.limit(DETAIL_LIMIT).to_a
      end
      @proposals = current_user.finance_category_proposals.pending.order(:id).to_a
      @missing_suggestions = @tree.missing_defaults.length
      @ai_available = AiCategorizer.available?
    end
  end
end
