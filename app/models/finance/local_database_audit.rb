module Finance
  # An append-only trail of identity decisions about local database METADATA: a device that
  # started reporting another database, the same database seen from two devices, a legacy
  # consolidation, a review decision. Never holds financial content, only ids, counts and times.
  class LocalDatabaseAudit < ActiveRecord::Base
    self.table_name = "finance_local_database_audits"
    self.record_timestamps = false

    EVENTS = %w[database_added database_superseded database_on_multiple_devices legacy_archived legacy_review
      review_archived review_restored device_renamed].freeze

    belongs_to :user

    validates :event, inclusion: {in: EVENTS}
    before_create { self.created_at ||= Time.current }

    def readonly? = persisted?

    def self.record!(user_id:, event:, device_id: nil, database_id: nil, **details)
      create!(user_id: user_id, event: event, device_id: device_id, database_id: database_id, details: details)
    end
  end
end
