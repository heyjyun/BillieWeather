require "digest"

module Finance
  # Serialize web and API preference writes with the same user lock. Module revisions are
  # independent. The sum of all explicit row revisions is the monotonic account revision.
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
      @user.with_lock { snapshot_for(choices) }
    end

    def apply(request)
      device, mutation, base_revision, changes = parse(request)
      digest = Digest::SHA256.hexdigest(JSON.generate([device, base_revision, changes]))
      @user.with_lock do
        prior = ModulePreferenceMutation.find_by(user_id: @user.id, mutation_id: mutation)
        if prior
          raise MutationReused unless prior.request_hash == digest
          next prior.result
        end

        rows = choices
        applied = []
        conflicts = []
        changes.each do |id, enabled, expected|
          record = rows[id]
          if (record&.revision || 0) == expected
            rows[id] = ModulePreference.write_choice!(user: @user, record: record, module_key: id,
              enabled: enabled, device_id: device)
            applied << id
          else
            conflicts << {module_key: id, proposed_enabled: enabled, current: record ? choice(record) : default_choice(id)}
          end
        end

        result = snapshot_for(rows).merge(applied: applied, conflicts: conflicts).deep_stringify_keys
        ModulePreferenceMutation.create!(user: @user, mutation_id: mutation, device_id: device, request_hash: digest, result: result)
        result
      end
    end

    private

    def choices
      ModulePreference.where(user_id: @user.id).index_by(&:module_key)
    end

    def snapshot_for(rows)
      {
        format: FORMAT, account_id: @user.finance_owner_uid, server_revision: rows.values.sum(&:revision),
        modules: rows.transform_values { |record| choice(record) }, defaults_version: ModuleCatalog::SCHEMA.fetch("version")
      }
    end

    def choice(record)
      {enabled: record.enabled, revision: record.revision, changed_at: record.changed_at.utc.iso8601(6), updated_by_device_id: record.updated_by_device_id}
    end

    def default_choice(id)
      {enabled: ModuleCatalog.find(id).default_enabled, revision: 0, changed_at: nil, updated_by_device_id: nil}
    end

    def parse(request)
      device = request["device_id"]
      mutation = request["mutation_id"]
      base_revision = request["base_server_revision"]
      raw = request["changes"]
      raise Invalid unless request["format"] == FORMAT && uuid?(device) && uuid?(mutation) && revision?(base_revision)
      raise Invalid unless raw.is_a?(Array) && (1..MAX_CHANGES).cover?(raw.length)

      changes = raw.map do |item|
        raise Invalid unless item.is_a?(Hash)
        id, enabled, expected = item.values_at("module_key", "enabled", "expected_revision")
        raise Invalid unless id.is_a?(String) && ModuleCatalog.find(id)&.available?("app")
        raise Invalid unless [true, false].include?(enabled) && revision?(expected)
        [id, enabled, expected]
      end
      raise Invalid unless changes.map(&:first).uniq.length == changes.length
      [device, mutation, base_revision, changes.sort_by(&:first)]
    end

    def uuid?(value) = value.is_a?(String) && UUID.match?(value)
    def revision?(value) = value.is_a?(Integer) && (0..MAX_REVISION).cover?(value)
  end
end
