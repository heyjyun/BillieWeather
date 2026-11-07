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
    validates :category, inclusion: {in: CATEGORIES}
    validates :tax_review, :excluded, inclusion: {in: [true, false]}
    validate :same_owner_as_statement
    validate :amount_has_cent_precision

    private

    def amount_has_cent_precision
      value = BigDecimal(amount_before_type_cast.to_s, exception: false)
      if value&.finite? && value != value.round(2)
        errors.add(:amount, "must have at most two decimal places")
      end
    end

    def same_owner_as_statement
      if statement && user_id != statement.user_id
        errors.add(:statement, "must belong to the same account")
      end
    end
  end
end
