module Finance
  # A new subcategory the AI suggested during "Categorize with AI" on the website
  # (docs/architecture/category-hierarchy.md, AI). Never created automatically: the person approves
  # (optionally with another name) or dismisses it on the Categories page. Approving creates the
  # subcategory under `parent_name` and files the proposal's still-Uncategorized transactions under
  # it as one audited, undoable batch. `payload`: {"transaction_ids" => [...], "texts" => [...]}.
  class CategoryProposal < ActiveRecord::Base
    self.table_name = "finance_category_proposals"

    STATUSES = %w[pending approved dismissed].freeze

    belongs_to :user

    scope :pending, -> { where(status: "pending") }

    validates :parent_name, :name, presence: true, length: {maximum: Category::MAX_LENGTH}
    validates :status, inclusion: {in: STATUSES}

    def transaction_ids = Array(payload["transaction_ids"]).map(&:to_i)

    def texts = Array(payload["texts"])

    # Creates the subcategory and files the proposal's groups under it. Returns
    # {category:, updated:, batch_id:}. Raises ActiveRecord::RecordInvalid or Category::Invalid.
    def approve!(name: nil)
      raise Category::Invalid, :proposal_closed unless status == "pending"
      chosen = Category.normalize_name(name.presence || self.name)
      result = nil
      transaction do
        parent = Category.for_user(user).where("lower(name) = lower(?)", parent_name).first
        raise Category::Invalid, :parent_invalid unless parent
        category = Category.create_for!(user, name: chosen, parent: parent)
        AuditEvent.record!(user: user, action: "create", subject: ["Category", category.name], summary: category.name,
          changes: {"before" => {}, "after" => {"name" => category.name, "parent" => parent.name, "source" => "ai_proposal"}})
        applied = Ledger.new(user).apply_ai_categories([{ids: transaction_ids, category: category.name}], model: "openai")
        update!(status: "approved", name: category.name)
        result = {category: category, updated: applied[:updated], batch_id: applied[:batch_id]}
      end
      result
    end

    def dismiss!
      update!(status: "dismissed") if status == "pending"
    end
  end
end
