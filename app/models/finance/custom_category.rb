module Finance
  # Legacy table of a person's own categories from before the category hierarchy (2026-11). Its rows
  # were copied into finance_categories (Finance::Category) and it is no longer read or written; it
  # stays for rollback and is only cleared when a person deletes their financial data.
  class CustomCategory < ActiveRecord::Base
    self.table_name = "finance_custom_categories"

    belongs_to :user
  end
end
