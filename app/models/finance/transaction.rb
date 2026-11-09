module Finance
  class Transaction < ActiveRecord::Base
    self.table_name = "finance_transactions"

    CATEGORIES = ["Income", "Housing", "Food & dining", "Transport", "Utilities", "Shopping", "Health", "Business", "Transfers", "Uncategorized"].freeze

    belongs_to :user
    belongs_to :statement, class_name: "Finance::Statement", inverse_of: :transactions

    scope :included, -> { where(excluded: false).where.not(category: "Transfers") }
    scope :recent_first, -> { order(booked_on: :desc, id: :desc) }

    validates :booked_on, :description, presence: true
    validates :description, length: {maximum: 500}
    validates :amount, numericality: {greater_than: -10**13, less_than: 10**13}
    validate :category_is_known
    validates :tax_review, :excluded, inclusion: {in: [true, false]}
    validate :same_owner_as_statement
    validate :amount_has_cent_precision

    private

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

    def same_owner_as_statement
      if statement && user_id != statement.user_id
        errors.add(:statement, :same_statement_owner)
      end
    end
  end
end
