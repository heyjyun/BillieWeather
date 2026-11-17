module Finance
  class TransactionTag < ActiveRecord::Base
    self.table_name = "finance_transaction_tags"
    self.primary_key = [:transaction_id, :tag_id]

    belongs_to :finance_transaction, class_name: "Finance::Transaction", foreign_key: :transaction_id, inverse_of: :transaction_tags
    belongs_to :tag, class_name: "Finance::Tag"

    # The join row names its owner, so the database itself refuses a tag of one person on an entry
    # of another (composite foreign keys to both sides; migration 20261116000100).
    before_validation { self.user_id ||= finance_transaction&.user_id }
  end
end
