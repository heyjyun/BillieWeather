module Finance
  class Statement < ActiveRecord::Base
    self.table_name = "finance_statements"

    belongs_to :user
    belongs_to :bank_account, class_name: "Finance::BankAccount", optional: true
    has_many :transactions, class_name: "Finance::Transaction", dependent: :destroy, inverse_of: :statement

    validates :filename, presence: true, length: {maximum: 255}
    validates :currency, inclusion: {in: Finance::Profile::CURRENCIES}
    validates :sha256, format: {with: /\A[0-9a-f]{64}\z/}, uniqueness: {scope: :user_id}
    validates :transaction_count, numericality: {only_integer: true, greater_than: 0}
    validate :bank_account_belongs_to_user
    after_update :sync_transaction_account, if: :saved_change_to_bank_account_id?

    private

    # The ledger reads the transaction's account directly. Reassigning statement evidence must
    # move its entries in the same transaction, while preserving explicit per-entry overrides.
    def sync_transaction_account
      previous = bank_account_id_before_last_save
      transactions.where(user_id: user_id, bank_account_id: [previous, nil]).where.not("jsonb_exists(user_locked_fields, 'account')")
        .update_all(bank_account_id: bank_account_id, updated_at: Time.current)
    end

    def bank_account_belongs_to_user
      errors.add(:bank_account, :same_owner) if bank_account && bank_account.user_id != user_id
    end
  end
end
