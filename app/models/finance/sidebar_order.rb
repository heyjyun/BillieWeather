module Finance
  # The person's saved sidebar order (Settings › Sidebar customization): module ids in the order they
  # arranged them. One row per account, shared by the website and the apps (ModulePreferenceSync).
  # Navigation only: it never decides whether a module works, and ids of hidden or unknown modules
  # simply add no entry (ModuleCatalog.order_sidebar). No row means catalog order.
  #
  # Writes serialize on the user row, like ModulePreference, and compare revisions.
  class SidebarOrder < ActiveRecord::Base
    self.table_name = "finance_sidebar_orders"

    belongs_to :user

    validate :keys_are_known_modules

    # The saved order for this person, or [] (catalog order).
    def self.keys_for(user) = find_by(user_id: user.id)&.module_keys || []

    def self.revision_for(user) = find_by(user_id: user.id)&.revision || 0

    def self.set!(user:, module_keys:, expected_revision: nil, now: Time.current)
      user.with_lock do
        record = find_by(user_id: user.id)
        raise ModulePreferenceSync::StaleChoice if expected_revision && (record&.revision || 0) != expected_revision
        write!(user: user, record: record, module_keys: module_keys, now: now)
      end
    end

    # Call only while holding the user's write lock.
    def self.write!(user:, record:, module_keys:, surface: ModuleCatalog::SURFACE, now: Time.current, device_id: nil)
      record ||= new(user: user, revision: 0)
      keys = ModuleCatalog.normalize_order(module_keys)
      # A surface submits only its own order. Keep entries it cannot see in their previous slots.
      record.module_keys.each_with_index do |id, index|
        definition = ModuleCatalog.find(id)
        next unless definition && !definition.available?(surface) && !keys.include?(id)

        keys.insert([index, keys.length].min, id)
      end
      record.assign_attributes(module_keys: keys, changed_at: now, revision: record.revision + 1)
      record.updated_by_device_id = device_id
      record.save!
      record
    end

    private

    def keys_are_known_modules
      errors.add(:module_keys, :invalid) unless module_keys.is_a?(Array) && module_keys.all? { |id| ModuleCatalog.find(id) } && module_keys.uniq.length == module_keys.length
    end
  end
end
