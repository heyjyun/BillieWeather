module Finance
  # An explicit relation between entries (transfer legs, card payment, refund of an expense, duplicate).
  # Automation only suggests; a person confirms.
  class TransactionLink < ActiveRecord::Base
    self.table_name = "finance_transaction_links"

    belongs_to :user
    belongs_to :from_transaction, class_name: "Finance::Transaction"
    belongs_to :to_transaction, class_name: "Finance::Transaction", optional: true

    validates :link_type, inclusion: {in: Domain::LINK_TYPES}
    validates :status, inclusion: {in: Domain::LINK_STATUSES}
    validates :decided_by, inclusion: {in: Domain::DECIDED_BY}
    validate :same_owner
    validate :transfer_balances

    scope :confirmed, -> { where(status: "confirmed") }
    scope :suggested, -> { where(status: "suggested") }

    private

    def same_owner
      [from_transaction, to_transaction].compact.each do |entry|
        errors.add(:base, :same_owner) if entry.user_id != user_id
      end
    end

    # I-3: confirmed transfer legs sum to zero (one currency per user today).
    def transfer_balances
      return unless %w[transfer card_payment].include?(link_type) && status == "confirmed" && to_transaction
      errors.add(:base, :unbalanced) unless (from_transaction.amount + to_transaction.amount).zero?
    end
  end
end
