require "digest"

module Finance
  # Cross-device sync of sidebar choices (Settings › Feature Library). Serialize web and API
  # preference writes with the same user lock. Module revisions are independent. The sum of all
  # explicit row revisions is the monotonic account revision.
  #
  # Wire contract (format 2): a choice is `sidebar_visible`. Apps released before 2026-11-26 send and
  # read the same value under the legacy name `enabled`, so both names are accepted and both are
  # returned; they always carry the same value. Neither name ever means "the feature is switched off".
  #
  # Sidebar order (2026-11-28): the snapshot reports `sidebar_order` (null when none is saved) and a
  # request may carry `sidebar_order: {module_keys, expected_revision}`, with or without module changes.
  # Its revision joins the account revision. Apps that do not know it never send it and ignore it.
  class ModulePreferenceSync
    FORMAT = 2
    MAX_CHANGES = 20
    MAX_REVISION = (2**53) - 1
    UUID = /\A[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\z/

    class Invalid < StandardError; end
    class MutationReused < StandardError; end
    class StaleChoice < StandardError; end

    def self.enabled? = ENV["BILLIE_MODULE_SYNC"] == "1"

    def initialize(user)
      @user = user
    end

    def snapshot
      @user.with_lock { snapshot_for(choices, SidebarOrder.find_by(user_id: @user.id)) }
    end

    def apply(request)
      device, mutation, base_revision, changes, order = parse(request)
      digest = Digest::SHA256.hexdigest(JSON.generate([device, base_revision, changes, order].compact))
      @user.with_lock do
        prior = ModulePreferenceMutation.find_by(user_id: @user.id, mutation_id: mutation)
        if prior
          raise MutationReused unless prior.request_hash == digest
          next prior.result
        end

        rows = choices
        order_row = SidebarOrder.find_by(user_id: @user.id)
        order_result = {}
        if order
          keys, expected = order
          if (order_row&.revision || 0) == expected
            order_row = SidebarOrder.write!(user: @user, record: order_row, module_keys: keys, surface: "app", device_id: device)
            order_result = {order_applied: true, order_conflict: nil}
          else
            order_result = {order_applied: false, order_conflict: {proposed_module_keys: keys, current: order_row && order_choice(order_row)}}
          end
        end
        applied = []
        conflicts = []
        changes.each do |id, visible, expected|
          record = rows[id]
          if (record&.revision || 0) == expected
            rows[id] = ModulePreference.write_choice!(user: @user, record: record, module_key: id,
              sidebar_visible: visible, device_id: device)
            applied << id
          else
            conflicts << {module_key: id, proposed_sidebar_visible: visible, proposed_enabled: visible,
                          current: record ? choice(record) : default_choice(id)}
          end
        end

        result = snapshot_for(rows, order_row).merge(applied: applied, conflicts: conflicts, **order_result).deep_stringify_keys
        ModulePreferenceMutation.create!(user: @user, mutation_id: mutation, device_id: device, request_hash: digest, result: result)
        result
      end
    end

    private

    def choices
      ModulePreference.where(user_id: @user.id).index_by(&:module_key)
    end

    def snapshot_for(rows, order_row)
      {
        format: FORMAT, account_id: @user.finance_owner_uid, server_revision: rows.values.sum(&:revision) + (order_row&.revision || 0),
        modules: rows.transform_values { |record| choice(record) }, defaults_version: ModuleCatalog::SCHEMA.fetch("version"),
        sidebar_order: order_row && order_choice(order_row)
      }
    end

    def order_choice(record)
      {module_keys: record.module_keys, revision: record.revision, changed_at: record.changed_at.utc.iso8601(6), updated_by_device_id: record.updated_by_device_id}
    end

    def choice(record)
      {sidebar_visible: record.sidebar_visible, enabled: record.sidebar_visible, revision: record.revision,
       changed_at: record.changed_at.utc.iso8601(6), updated_by_device_id: record.updated_by_device_id}
    end

    def default_choice(id)
      visible = ModuleCatalog.find(id).default_sidebar_visible
      {sidebar_visible: visible, enabled: visible, revision: 0, changed_at: nil, updated_by_device_id: nil}
    end

    def parse(request)
      device = request["device_id"]
      mutation = request["mutation_id"]
      base_revision = request["base_server_revision"]
      raw = request["changes"]
      raise Invalid unless request["format"] == FORMAT && uuid?(device) && uuid?(mutation) && revision?(base_revision)
      order = parse_order(request["sidebar_order"])
      minimum = order ? 0 : 1 # an order-only request carries no module change
      raise Invalid unless raw.is_a?(Array) && (minimum..MAX_CHANGES).cover?(raw.length)

      changes = raw.map do |item|
        raise Invalid unless item.is_a?(Hash)
        id, expected = item.values_at("module_key", "expected_revision")
        raise Invalid unless id.is_a?(String) && ModuleCatalog.find(id)&.available?("app")
        visible = sidebar_choice(item)
        raise Invalid unless [true, false].include?(visible) && revision?(expected)
        [id, visible, expected]
      end
      raise Invalid unless changes.map(&:first).uniq.length == changes.length
      [device, mutation, base_revision, changes.sort_by(&:first), order]
    end

    # nil when absent; [keys, expected_revision] when valid. Keys: modules the apps can show, each once.
    def parse_order(raw)
      return nil if raw.nil?
      raise Invalid unless raw.is_a?(Hash)
      keys, expected = raw.values_at("module_keys", "expected_revision")
      raise Invalid unless keys.is_a?(Array) && keys.length <= ModuleCatalog::IDS.length && revision?(expected)
      raise Invalid unless keys.all? { |id| id.is_a?(String) && ModuleCatalog.find(id)&.available?("app") } && keys.uniq.length == keys.length
      [keys, expected]
    end

    # `sidebar_visible`, or the legacy `enabled` from older apps. Both present and different: invalid.
    def sidebar_choice(item)
      current, legacy = item.values_at("sidebar_visible", "enabled")
      return current if legacy.nil?
      return legacy if current.nil?
      raise Invalid unless current == legacy
      current
    end

    def uuid?(value) = value.is_a?(String) && UUID.match?(value)
    def revision?(value) = value.is_a?(Integer) && (0..MAX_REVISION).cover?(value)
  end
end
