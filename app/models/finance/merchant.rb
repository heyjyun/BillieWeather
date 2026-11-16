module Finance
  class Merchant < ActiveRecord::Base
    self.table_name = "finance_merchants"
    include Dimension
    has_many :transactions, class_name: "Finance::Transaction", dependent: :nullify
  end
end
