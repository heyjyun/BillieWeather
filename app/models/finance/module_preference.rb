module Finance
  # One explicit sidebar choice from Settings › Feature Library: whether a module has a sidebar entry.
  # It is never a permission; every available module works whatever is stored here. An absent row
  # uses the catalog default (Finance::ModuleCatalog).
  #
  # The column is still named `enabled` (finance_module_preferences, 2026-11-23). It has always held the
  # sidebar choice, so existing rows keep their meaning exactly; renaming it would be a breaking
  # migration for little gain. Code uses `sidebar_visible`.
  #
  # Both web and native writes serialize on the user row before comparing revisions.
  class ModulePreference < ActiveRecord::Base
    self.table_name = "finance_module_preferences"

    alias_attribute :sidebar_visible, :enabled

    belongs_to :user

    validates :module_key, inclusion: {in: ModuleCatalog::IDS}
    validates :enabled, inclusion: {in: [true, false]}
    validate :module_is_available

    def self.set!(user:, module_key:, sidebar_visible:, now: Time.current, expected_revision: nil)
      user.with_lock do
        record = find_by(user_id: user.id, module_key: module_key.to_s)
        if expected_revision && (record&.revision || 0) != expected_revision
          raise ModulePreferenceSync::StaleChoice
        end
        write_choice!(user: user, record: record, module_key: module_key, sidebar_visible: sidebar_visible, now: now)
      end
    end

    def self.restore_sidebar_defaults!(user:, surface: ModuleCatalog::SURFACE)
      user.with_lock do
        records = where(user_id: user.id).index_by(&:module_key)
        ModuleCatalog.enabled_modules(surface: surface).each do |definition|
          record = records[definition.id]
          next unless record && record.sidebar_visible != definition.default_sidebar_visible

          write_choice!(user: user, record: record, module_key: definition.id, sidebar_visible: definition.default_sidebar_visible)
        end
        # Default order too: an empty saved list means catalog order.
        order = SidebarOrder.find_by(user_id: user.id)
        SidebarOrder.write!(user: user, record: order, module_keys: []) if order&.module_keys.present?
      end
    end

    # Call only while holding the user's write lock.
    def self.write_choice!(user:, record:, module_key:, sidebar_visible:, now: Time.current, device_id: nil)
      record ||= new(user: user, module_key: module_key.to_s, revision: 0)
      record.assign_attributes(sidebar_visible: sidebar_visible, changed_at: now, revision: record.revision + 1)
      record.updated_by_device_id = device_id if record.has_attribute?(:updated_by_device_id)
      record.save!
      record
    end

    private

    # The account can also store choices for modules that only work in an installed app.
    def module_is_available
      definition = ModuleCatalog.find(module_key)
      errors.add(:module_key, :exclusion) if definition && !definition.availability.value?("available")
    end
  end
end
