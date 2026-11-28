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

    # PostgreSQL recorded this data migration and its inserts in the same transaction. Use that
    # provenance only for untouched inserts. If a dump/reload lost it, preserve the ambiguous row.
    # Keep even proven inherited rows in snapshots so revision checks and retries still work.
    def self.for_sidebar(user)
      where(user_id: user.id).select("finance_module_preferences.*", Arel.sql(<<~SQL.squish))
        (module_key IN ('overview', 'accounts', 'categories') AND enabled AND revision = 1
          AND changed_at = created_at AND updated_at = created_at AND updated_by_device_id IS NULL
          AND EXISTS (
            SELECT 1 FROM schema_migrations migration
            WHERE migration.version = '20261128000200' AND migration.xmin::text::bigint > 2
              AND migration.xmin = finance_module_preferences.xmin
              AND NOT EXISTS (SELECT 1 FROM schema_migrations other
                              WHERE other.version <> migration.version AND other.xmin = migration.xmin)
          )) AS legacy_inherited
      SQL
    end

    def inherited_sidebar_choice?
      revision == 1 && has_attribute?(:legacy_inherited) && self[:legacy_inherited] == true
    end

    def effective_sidebar_visible
      inherited_sidebar_choice? ? ModuleCatalog.find(module_key).default_sidebar_visible : sidebar_visible
    end

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
        records = for_sidebar(user).index_by(&:module_key)
        ModuleCatalog.enabled_modules(surface: surface).each do |definition|
          record = records[definition.id]
          next unless record && record.effective_sidebar_visible != definition.default_sidebar_visible

          write_choice!(user: user, record: record, module_key: definition.id, sidebar_visible: definition.default_sidebar_visible)
        end
        # Restore the order for this surface along with its visibility choices.
        order = SidebarOrder.find_by(user_id: user.id)
        if order&.module_keys&.any? { |id| ModuleCatalog.find(id)&.available?(surface) }
          SidebarOrder.write!(user: user, record: order, module_keys: [], surface: surface)
        end
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
