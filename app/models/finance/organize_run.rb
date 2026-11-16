module Finance
  # One "Organize my finances" run: proposals (preview), what was applied (batch of audit events) and undo.
  class OrganizeRun < ActiveRecord::Base
    self.table_name = "finance_organize_runs"

    belongs_to :user
    validates :status, inclusion: {in: %w[preview applied undone discarded]}
  end
end
