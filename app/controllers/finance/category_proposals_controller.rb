module Finance
  # New subcategories proposed by "Categorize with AI" (docs/architecture/category-hierarchy.md).
  # Nothing is created until the person approves: approving (optionally with another name) creates
  # the subcategory and files the proposal's still-Uncategorized transactions under it as one
  # audited batch that can be undone; dismissing just closes the proposal.
  class CategoryProposalsController < BaseController
    before_action :load_proposal

    def approve
      result = @proposal.approve!(name: params[:name])
      flash[:ai_batch_id] = result[:batch_id] if result[:batch_id]
      redirect_to finance_categories_path(name: result[:category].name),
        notice: I18n.t("billie.categories.proposal_approved", name: result[:category].name, count: result[:updated])
    rescue ActiveRecord::RecordInvalid => error
      message = if error.record.errors.of_kind?(:name, :taken) then I18n.t("billie.categories.errors.taken")
      elsif error.record.errors.of_kind?(:base, :too_many) then I18n.t("billie.categories.errors.too_many", count: Category::MAX_PER_USER)
      elsif error.record.errors.of_kind?(:name, :reserved) then I18n.t("billie.categories.errors.reserved")
      else I18n.t("billie.categories.errors.blank")
      end
      redirect_to finance_categories_path(anchor: "category-proposals"), alert: message
    rescue Category::Invalid => error
      redirect_to finance_categories_path(anchor: "category-proposals"), alert: I18n.t("billie.categories.errors.#{error.code}", default: I18n.t("billie.ledger.errors.generic"))
    end

    def dismiss
      @proposal.dismiss!
      redirect_to finance_categories_path(anchor: "category-proposals"), notice: I18n.t("billie.categories.proposal_dismissed", name: @proposal.name)
    end

    private

    def load_proposal
      @proposal = current_user.finance_category_proposals.find(params[:id])
    end
  end
end
