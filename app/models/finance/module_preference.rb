module Finance
  # One explicit Feature Library choice for one person on the website ("show Budgets", "hide AI
  # Assistant"). Absence means the catalog default (Finance::ModuleCatalog). Not financial data:
  # changing it never touches a transaction, account or receipt. `revision` grows with every change
  # and `changed_at` is when the person made it, for the Phase 1b cross-device merge (not built yet).
  class ModulePreference < ActiveRecord::Base
    self.table_name = "finance_module_preferences"

    belongs_to :user

    validates :module_key, inclusion: {in: ModuleCatalog::IDS}
    validates :enabled, inclusion: {in: [true, false]}
    validate :module_is_available

    # Records the person's choice. Raises ActiveRecord::RecordInvalid for unknown or coming-soon modules.
    def self.set!(user:, module_key:, enabled:, now: Time.current)
      transaction do
        record = lock.find_or_initialize_by(user_id: user.id, module_key: module_key.to_s)
        record.enabled = enabled
        record.changed_at = now
        record.revision = record.new_record? ? 1 : record.revision + 1
        record.save!
        record
      end
    rescue ActiveRecord::RecordNotUnique
      retry
    end

    private

    def module_is_available
      definition = ModuleCatalog.find(module_key)
      errors.add(:module_key, :exclusion) if definition && !definition.available?
    end
  end
end
