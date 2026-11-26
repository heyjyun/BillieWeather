module Finance
  # Legacy per-person category arrangement (parent, kind, order, hidden) from before the category
  # hierarchy (2026-11). Copied into finance_categories (Finance::Category); no longer read or
  # written. Kept for rollback and only cleared when a person deletes their financial data.
  class CategorySetting < ActiveRecord::Base
    self.table_name = "finance_category_settings"

    belongs_to :user
  end
end
