module Finance
  class TransactionTag < ActiveRecord::Base
    self.table_name = "finance_transaction_tags"
    self.primary_key = [:transaction_id, :tag_id]

    belongs_to :finance_transaction, class_name: "Finance::Transaction", foreign_key: :transaction_id, inverse_of: :transaction_tags
    belongs_to :tag, class_name: "Finance::Tag"
  end
end
