module Finance
  # One movement of money in one account (docs/architecture/finance-domain-spec.md). Income and expense
  # come from `kind`, never from the sign alone. `original_description` is what the bank printed and is
  # never changed; `description` is the editable display text.
  class Transaction < ActiveRecord::Base
    self.table_name = "finance_transactions"

    CATEGORIES = ["Income", "Housing", "Food & dining", "Transport", "Utilities", "Shopping", "Health", "Business", "Transfers", "Uncategorized"].freeze
    KINDS = Domain::TRANSACTION_KINDS
    TRANSFER_LIKE = (KINDS - Domain::COUNTED_KINDS).freeze
    LOCKABLE = Domain::LOCKED_FIELDS

    belongs_to :user
    belongs_to :statement, class_name: "Finance::Statement", inverse_of: :transactions, optional: true
    belongs_to :bank_account, class_name: "Finance::BankAccount", optional: true
    belongs_to :merchant, class_name: "Finance::Merchant", optional: true
    belongs_to :project, class_name: "Finance::Project", optional: true
    belongs_to :recurring_rule, class_name: "Finance::RecurringRule", optional: true
    has_many :transaction_tags, class_name: "Finance::TransactionTag", foreign_key: :transaction_id, inverse_of: :finance_transaction, dependent: :delete_all
    has_many :tags, through: :transaction_tags, class_name: "Finance::Tag"
    has_many :outgoing_links, class_name: "Finance::TransactionLink", foreign_key: :from_transaction_id, dependent: :delete_all
    has_many :incoming_links, class_name: "Finance::TransactionLink", foreign_key: :to_transaction_id, dependent: :delete_all

    attr_readonly :original_description

    # Live rows: everything not in the trash. `included` rows count in income/expense totals.
    scope :live, -> { where(deleted_at: nil) }
    scope :trashed, -> { where.not(deleted_at: nil) }
    scope :included, -> { live.where(excluded: false, kind: Domain::COUNTED_KINDS) }
    scope :income_kind, -> { where(kind: Domain::INCOME_KINDS) }
    scope :expense_kind, -> { where(kind: Domain::EXPENSE_KINDS) }
    scope :recent_first, -> { order(booked_on: :desc, id: :desc) }

    before_validation :fill_original_description, on: :create
    before_validation :keep_kind_with_category

    validates :booked_on, :description, presence: true
    validates :description, length: {maximum: 500}
    validates :original_description, presence: true, length: {maximum: 500}
    validates :amount, numericality: {greater_than: -10**13, less_than: 10**13}
    validates :kind, inclusion: {in: KINDS}
    validates :entry_origin, inclusion: {in: Domain::ENTRY_ORIGINS}
    validates :category_source, inclusion: {in: Domain::CATEGORY_SOURCES}
    validates :occurred_at_time, format: {with: /\A[0-2]\d:[0-5]\d\z/}, allow_nil: true
    validates :note, length: {maximum: 1000}
    validate :category_is_known
    validates :tax_review, :excluded, inclusion: {in: [true, false]}
    validate :same_owner_as_references
    validate :statement_or_manual
    validate :amount_has_cent_precision
    validate :locked_fields_are_known

    # The category name a transfer-like kind carries (kept for older readers of the text column).
    def self.category_for_kind(kind, category)
      TRANSFER_LIKE.include?(kind.to_s) ? "Transfers" : category
    end

    # Whether a category is in the income tree (built-in Income or a custom income category).
    def self.income_category?(user_id, name)
      return true if name == "Income"
      return false if CATEGORIES.include?(name)
      CategorySetting.where(user_id: user_id).where("lower(name) = ?", name.to_s.downcase).pick(:category_kind) == "income"
    end

    # Bulk category changes (rules, AI, renames) keep `kind` consistent with the new category, like
    # `keep_kind_with_category` does for single edits. Rows whose kind a person locked are skipped.
    def self.sync_kinds_for_category!(scope, category, user_id)
      unlocked = scope.where.not("jsonb_exists(user_locked_fields, 'kind')")
      if category == "Transfers"
        unlocked.where(kind: Domain::COUNTED_KINDS).update_all(kind: "transfer")
      elsif income_category?(user_id, category)
        unlocked.where(kind: Domain::COUNTED_KINDS).where("amount > 0").update_all(kind: "income")
      elsif category != "Uncategorized"
        unlocked.where(kind: Domain::COUNTED_KINDS + ["transfer"]).update_all(Arel.sql("kind = CASE WHEN amount > 0 THEN 'refund' ELSE 'expense' END"))
      end
    end

    def counted?
      deleted_at.nil? && !excluded && Domain::COUNTED_KINDS.include?(kind)
    end

    def transfer_like?
      TRANSFER_LIKE.include?(kind)
    end

    def manual?
      %w[manual recurring].include?(entry_origin)
    end

    def locked?(field)
      Array(user_locked_fields).include?(field.to_s)
    end

    def lock_fields!(*fields)
      self.user_locked_fields = (Array(user_locked_fields) | fields.map(&:to_s)) & LOCKABLE
    end

    # The account type used to interpret this row (from its account or its statement's account).
    def account_type
      (bank_account || statement&.bank_account)&.account_type
    end

    def merchant_key
      Categorizer.merchant_key(original_description.presence || description)
    end

    def edited_description?
      original_description.present? && description != original_description
    end

    private

    def fill_original_description
      self.original_description = description if original_description.blank?
    end

    # The category select is still the main control: choosing Transfers makes the row a transfer,
    # choosing an expense category on money in makes it a refund, Income makes it income.
    def keep_kind_with_category
      return unless will_save_change_to_category? && !will_save_change_to_kind?
      return if category.blank? || category == "Uncategorized"
      positive = amount.to_d.positive?
      self.kind = if category == "Transfers"
        transfer_like? ? kind : "transfer"
      elsif self.class.income_category?(user_id, category)
        positive ? "income" : kind_without_transfer
      else
        positive ? "refund" : "expense"
      end
    end

    def kind_without_transfer
      transfer_like? ? "expense" : kind
    end

    # A built-in category or one of this person's own (Finance::CustomCategory).
    def category_is_known
      return if CATEGORIES.include?(category)
      return if category.present? && user_id && CustomCategory.where(user_id: user_id, name: category).exists?
      errors.add(:category, :inclusion)
    end

    def amount_has_cent_precision
      value = BigDecimal(amount_before_type_cast.to_s, exception: false)
      if value&.finite? && value != value.round(2)
        errors.add(:amount, :cent_precision)
      end
    end

    def same_owner_as_references
      errors.add(:statement, :same_statement_owner) if statement && user_id != statement.user_id
      [[:bank_account, bank_account], [:merchant, merchant], [:project, project], [:recurring_rule, recurring_rule]].each do |name, record|
        errors.add(name, :same_owner) if record && record.user_id != user_id
      end
    end

    def statement_or_manual
      errors.add(:statement, :blank) if statement_id.nil? && !manual?
    end

    def locked_fields_are_known
      unless user_locked_fields.is_a?(Array) && (user_locked_fields - LOCKABLE).empty?
        errors.add(:user_locked_fields, :inclusion)
      end
    end
  end
end
