module Finance
  class Tag < ActiveRecord::Base
    self.table_name = "finance_tags"
    include Dimension
    has_many :transaction_tags, class_name: "Finance::TransactionTag", dependent: :delete_all
    has_many :transactions, through: :transaction_tags, source: :finance_transaction
  end
end
