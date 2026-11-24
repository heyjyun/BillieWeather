module Finance
  # One explicit Feature Library choice. An absent row uses the shared catalog default.
  # Both web and native writes serialize on the user row before comparing revisions.
  class ModulePreference < ActiveRecord::Base
    self.table_name = "finance_module_preferences"

    belongs_to :user

    validates :module_key, inclusion: {in: ModuleCatalog::IDS}
    validates :enabled, inclusion: {in: [true, false]}
    validate :module_is_available

    def self.set!(user:, module_key:, enabled:, now: Time.current, expected_revision: nil)
      user.with_lock do
        record = find_by(user_id: user.id, module_key: module_key.to_s)
        if expected_revision && (record&.revision || 0) != expected_revision
          raise ModulePreferenceSync::StaleChoice
        end
        write_choice!(user: user, record: record, module_key: module_key, enabled: enabled, now: now)
      end
    end

    # Call only while holding the user's write lock.
    def self.write_choice!(user:, record:, module_key:, enabled:, now: Time.current, device_id: nil)
      record ||= new(user: user, module_key: module_key.to_s, revision: 0)
      record.assign_attributes(enabled: enabled, changed_at: now, revision: record.revision + 1)
      record.updated_by_device_id = device_id if record.has_attribute?(:updated_by_device_id)
      record.save!
      record
    end

    private

    def module_is_available
      definition = ModuleCatalog.find(module_key)
      errors.add(:module_key, :exclusion) if definition && !definition.available?
    end
  end
end
