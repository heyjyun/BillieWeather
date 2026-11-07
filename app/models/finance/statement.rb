module Finance
  class Statement < ActiveRecord::Base
    self.table_name = "finance_statements"

    belongs_to :user
    belongs_to :bank_account, class_name: "Finance::BankAccount", optional: true
    has_many :transactions, class_name: "Finance::Transaction", dependent: :destroy, inverse_of: :statement

    validates :filename, presence: true, length: {maximum: 255}
    validates :currency, inclusion: {in: Finance::Profile::CURRENCIES}
    validates :sha256, format: {with: /\A[0-9a-f]{64}\z/}, uniqueness: {scope: :user_id}
    validates :status, inclusion: {in: %w[imported]}
    validates :transaction_count, numericality: {only_integer: true, greater_than: 0}
    validate :bank_account_belongs_to_user

    private

    def bank_account_belongs_to_user
      errors.add(:bank_account, "must belong to you") if bank_account && bank_account.user_id != user_id
    end
  end
end
