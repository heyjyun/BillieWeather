module Finance
  class ModulePreferenceMutation < ActiveRecord::Base
    self.table_name = "finance_module_preference_mutations"

    belongs_to :user
  end
end
