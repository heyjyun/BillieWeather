module Finance
  class Project < ActiveRecord::Base
    self.table_name = "finance_projects"
    include Dimension
    has_many :transactions, class_name: "Finance::Transaction", dependent: :nullify
    has_many :budgets, class_name: "Finance::Budget", dependent: :destroy
  end
end
