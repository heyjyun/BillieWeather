module Finance
  # A matching decision between a receipt and a ledger entry (usually the bank's row): suggested by
  # the matcher, confirmed (automatically only at level "exact", otherwise by a person) or rejected
  # ("these are different purchases", remembered so it is never suggested again). Reversible through
  # Finance::ReceiptReconciler; every change is in the audit log.
  class ReceiptMatch < ActiveRecord::Base
    self.table_name = "finance_receipt_matches"

    STATUSES = %w[suggested confirmed rejected].freeze
    LEVELS = %w[exact probable ambiguous manual].freeze

    belongs_to :user
    belongs_to :receipt, class_name: "Finance::Receipt", inverse_of: :matches
    belongs_to :finance_transaction, class_name: "Finance::Transaction", foreign_key: :transaction_id

    validates :status, inclusion: {in: STATUSES}
    validates :level, inclusion: {in: LEVELS}
    validates :decided_by, inclusion: {in: %w[user auto]}
    validates :score, numericality: {only_integer: true, in: 0..100}
    validate :same_owner
    validate :only_exact_is_automatic

    scope :confirmed, -> { where(status: "confirmed") }
    scope :suggested, -> { where(status: "suggested") }
    scope :rejected, -> { where(status: "rejected") }

    def reason_codes = Array(reasons)

    private

    def same_owner
      [receipt, finance_transaction].compact.each { |record| errors.add(:base, :same_owner) if record.user_id != user_id }
    end

    def only_exact_is_automatic
      errors.add(:level, :automatic_needs_exact) if status == "confirmed" && decided_by == "auto" && level != "exact"
    end
  end
end
