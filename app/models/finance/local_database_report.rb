module Finance
  # What a person's app last told us about ONE database on their device: a name, a size and a
  # few counts. Reported by the app, shown on the website, never used to reach into the device.
  #
  # Identity: (user_id, device_id, database_id). The device id comes from a file the app keeps
  # next to its SQLite files; the database id is stored INSIDE each SQLite file. Neither is
  # derived from a name, a size, a launch time or a session, so reopening the app updates the
  # same row. Every write is a single INSERT … ON CONFLICT against a unique index (no
  # read-then-insert), so concurrent or repeated reports cannot create duplicates.
  #
  # Ordering: every report carries a per-device sequence number. A report is applied only if
  # its sequence is higher than the stored one (and higher than the device's last purge), so
  # retries, duplicates and out-of-order arrivals are harmless and a deleted database stays
  # deleted.
  #
  # Status: active rows make up the device cards; review rows are kept but listed separately
  # (legacy or ambiguous identity); archived rows are obsolete snapshots kept for the audit.
  class LocalDatabaseReport < ActiveRecord::Base
    self.table_name = "finance_local_database_reports"

    # The ONLY fields an app may send. Anything else is rejected, not ignored.
    ALLOWED_FIELDS = %w[name device_name platform size_bytes statement_count transaction_count rule_count
      period_start period_end modified_at opened_at synced_at sequence].freeze
    STALE_AFTER = 30.days
    STATUSES = %w[active review archived].freeze
    # Two devices reporting the same database id: never merged automatically.
    SHARED = "same_database_on_two_devices"
    SUPERSEDED = "superseded_by_other_device"
    SNAPSHOT_FIELDS = %w[name size_bytes statement_count transaction_count rule_count period_start period_end modified_at opened_at reported_at].freeze

    belongs_to :user

    scope :live, -> { where(deleted_at: nil) }
    scope :active, -> { live.where(status: "active") }
    scope :in_review, -> { live.where(status: "review") }
    scope :archived, -> { live.where(status: "archived") }

    validates :device_id, :database_id, format: {with: LocalDevice::UUID}
    validates :status, inclusion: {in: STATUSES}
    validates :name, presence: true, length: {maximum: 60}, unless: :deleted_at
    validates :size_bytes, numericality: {only_integer: true, in: 0...10**13}, unless: :deleted_at
    validates :statement_count, :transaction_count, :rule_count, numericality: {only_integer: true, in: 0...10**9}, unless: :deleted_at

    def stale?(now = Time.current)
      reported_at < now - STALE_AFTER
    end

    def empty_database?
      statement_count.to_i.zero? && transaction_count.to_i.zero? && rule_count.to_i.zero? && modified_at.nil? && period_start.nil?
    end

    def snapshot = attributes.slice(*SNAPSHOT_FIELDS).transform_values { |value| value.respond_to?(:iso8601) ? value.iso8601 : value }

    def set_status!(status, reason, now = Time.current)
      update_columns(status: status, status_reason: reason, status_changed_at: now)
    end

    # Applies a report (attributes given) or a deletion (no attributes) for one database.
    # Returns :applied or :ignored.
    def self.apply!(user:, device_id:, database_id:, sequence:, attributes: nil)
      transaction do
        lock_account(user)
        now = Time.current
        purged_through = touch_device(user.id, device_id, now)
        return :ignored if sequence <= purged_through.to_i

        row = attributes ? upsert_report(user.id, device_id, database_id, sequence, attributes, now) : upsert_tombstone(user.id, device_id, database_id, sequence, now)
        return :ignored unless row

        if attributes
          LocalDevice.where(user_id: user.id, device_id: device_id).update_all(
            name: attributes[:device_name], platform: attributes[:platform], last_reported_at: now, updated_at: now
          )
          reconcile_identity!(user.id, device_id, database_id, inserted: ActiveModel::Type::Boolean.new.cast(row["inserted"]), now: now)
        end
        :applied
      end
    end

    # Removes everything a device reported, and remembers the sequence so older reports that
    # arrive afterwards are refused. Returns :applied or :ignored.
    def self.purge_device!(user:, device_id:, sequence:)
      transaction do
        lock_account(user)
        now = Time.current
        row = write_returning(sanitize_sql_array([<<~SQL, user.id, device_id, sequence, now, now]))
          INSERT INTO finance_local_devices (user_id, device_id, purged_through, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?)
          ON CONFLICT (user_id, device_id) DO UPDATE
            SET purged_through = EXCLUDED.purged_through, name = NULL, updated_at = EXCLUDED.updated_at
            WHERE finance_local_devices.purged_through < EXCLUDED.purged_through
          RETURNING id
        SQL
        return :ignored unless row
        where(user_id: user.id, device_id: device_id).delete_all
        :applied
      end
    end

    # INSERT … RETURNING must never be answered from, or leave stale entries in, the query
    # cache (select_one alone counts as a read and would do both within one request).
    def self.write_returning(sql)
      connection.clear_query_cache
      connection.uncached { connection.select_one(sql, "#{name} Upsert") }
    ensure
      connection.clear_query_cache
    end
    private_class_method :write_returning

    # Reports of one account are applied one at a time, so the cross-device identity check
    # below sees a consistent picture. (The unique indexes alone already rule out duplicates.)
    def self.lock_account(user)
      User.where(id: user.id).lock.pick(:id)
    end
    private_class_method :lock_account

    # Creates the device row if needed (atomically) and returns its purge watermark.
    def self.touch_device(user_id, device_id, now)
      write_returning(sanitize_sql_array([<<~SQL, user_id, device_id, now, now]))
        INSERT INTO finance_local_devices (user_id, device_id, purged_through, created_at, updated_at)
        VALUES (?, ?, 0, ?, ?)
        ON CONFLICT (user_id, device_id) DO UPDATE SET purged_through = finance_local_devices.purged_through
        RETURNING purged_through
      SQL
        &.fetch("purged_through")
    end
    private_class_method :touch_device

    def self.upsert_report(user_id, device_id, database_id, sequence, attributes, now)
      a = attributes
      write_returning(sanitize_sql_array([<<~SQL, user_id, device_id, database_id, a[:name], a[:size_bytes], a[:statement_count], a[:transaction_count], a[:rule_count], a[:period_start], a[:period_end], a[:modified_at], a[:opened_at], a[:synced_at], sequence, now, now, now]))
        INSERT INTO finance_local_database_reports
          (user_id, device_id, database_id, name, size_bytes, statement_count, transaction_count, rule_count,
           period_start, period_end, modified_at, opened_at, synced_at, sequence, reported_at, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (user_id, device_id, database_id) DO UPDATE SET
          name = EXCLUDED.name, size_bytes = EXCLUDED.size_bytes, statement_count = EXCLUDED.statement_count,
          transaction_count = EXCLUDED.transaction_count, rule_count = EXCLUDED.rule_count,
          period_start = EXCLUDED.period_start, period_end = EXCLUDED.period_end, modified_at = EXCLUDED.modified_at,
          opened_at = EXCLUDED.opened_at, synced_at = EXCLUDED.synced_at, sequence = EXCLUDED.sequence,
          reported_at = EXCLUDED.reported_at, deleted_at = NULL, updated_at = EXCLUDED.updated_at
          WHERE finance_local_database_reports.sequence < EXCLUDED.sequence
        RETURNING id, (xmax = 0) AS inserted
      SQL
    end
    private_class_method :upsert_report

    def self.upsert_tombstone(user_id, device_id, database_id, sequence, now)
      write_returning(sanitize_sql_array([<<~SQL, user_id, device_id, database_id, sequence, now, now, now, now]))
        INSERT INTO finance_local_database_reports (user_id, device_id, database_id, sequence, reported_at, deleted_at, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (user_id, device_id, database_id) DO UPDATE SET
          sequence = EXCLUDED.sequence, reported_at = EXCLUDED.reported_at, deleted_at = EXCLUDED.deleted_at,
          name = NULL, size_bytes = NULL, statement_count = NULL, transaction_count = NULL, rule_count = NULL,
          period_start = NULL, period_end = NULL, modified_at = NULL, opened_at = NULL, synced_at = NULL,
          updated_at = EXCLUDED.updated_at
          WHERE finance_local_database_reports.sequence < EXCLUDED.sequence
        RETURNING id
      SQL
    end
    private_class_method :upsert_tombstone

    # A database id lives inside one SQLite file, so seeing it from a second device means the
    # device id was reset (reinstall, cleared app storage) or the file was copied. The first
    # time, the newest device takes over the card and the previous association is archived with
    # an audit entry. If the earlier device keeps reporting the same database, both copies are
    # alive: neither is chosen silently; both go to review.
    def self.reconcile_identity!(user_id, device_id, database_id, inserted:, now:)
      row = find_by!(user_id: user_id, device_id: device_id, database_id: database_id)
      others = live.where(user_id: user_id, database_id: database_id).where.not(device_id: device_id).to_a
      conflicts = others.select { |other| other.status == "active" || other.status_reason == SHARED }

      if conflicts.empty?
        if row.status != "active"
          LocalDatabaseAudit.record!(user_id: user_id, event: "review_restored", device_id: device_id, database_id: database_id,
            from_status: row.status, from_reason: row.status_reason, by: "device_report")
          row.set_status!("active", nil, now)
        end
      elsif [SUPERSEDED, SHARED].include?(row.status_reason)
        ([row] + conflicts).each { |other| other.set_status!("review", SHARED, now) unless other.status_reason == SHARED && other.status == "review" }
        LocalDatabaseAudit.record!(user_id: user_id, event: "database_on_multiple_devices", database_id: database_id,
          device_ids: ([device_id] + conflicts.map(&:device_id)).uniq.sort)
      else
        conflicts.each do |other|
          LocalDatabaseAudit.record!(user_id: user_id, event: "database_superseded", device_id: other.device_id, database_id: database_id,
            to_device_id: device_id, previous_snapshot: other.snapshot)
          other.set_status!("archived", SUPERSEDED, now)
        end
        row.set_status!("active", nil, now) unless row.status == "active"
      end

      if inserted
        previous = live.where(user_id: user_id, device_id: device_id).where.not(database_id: database_id).pluck(:database_id)
        if previous.any?
          LocalDatabaseAudit.record!(user_id: user_id, event: "database_added", device_id: device_id, database_id: database_id,
            other_databases_on_device: previous.sort)
        end
      end
    end
    private_class_method :reconcile_identity!
  end
end
