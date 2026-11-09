module Finance
  # What a person's app last told us about ONE database on their device: a name, a size and a
  # few counts. Reported by the app, shown on the website, never used to reach into the device.
  #
  # Ordering: every report carries a per-device sequence number. A report is applied only if
  # its sequence is higher than the stored one (and higher than the device's last purge), so
  # retries, duplicates and out-of-order arrivals are harmless and a deleted database stays
  # deleted.
  class LocalDatabaseReport < ActiveRecord::Base
    self.table_name = "finance_local_database_reports"

    # The ONLY fields an app may send. Anything else is rejected, not ignored.
    ALLOWED_FIELDS = %w[name device_name size_bytes statement_count transaction_count rule_count
      period_start period_end modified_at opened_at sequence].freeze
    STALE_AFTER = 30.days

    belongs_to :user

    scope :live, -> { where(deleted_at: nil) }

    validates :device_id, :database_id, format: {with: LocalDevice::UUID}
    validates :name, presence: true, length: {maximum: 60}, unless: :deleted_at
    validates :size_bytes, numericality: {only_integer: true, in: 0...10**13}, unless: :deleted_at
    validates :statement_count, :transaction_count, :rule_count, numericality: {only_integer: true, in: 0...10**9}, unless: :deleted_at

    def stale?(now = Time.current)
      reported_at < now - STALE_AFTER
    end

    # Applies a report or a deletion for one database. Returns :applied or :ignored.
    def self.apply!(user:, device_id:, database_id:, sequence:, attributes: nil)
      user.with_lock do
        device = LocalDevice.find_or_initialize_by(user_id: user.id, device_id: device_id)
        return :ignored if sequence <= device.purged_through
        if attributes
          device.name = attributes[:device_name] if attributes.key?(:device_name)
          device.save!
        elsif device.new_record?
          device.save!
        end
        report = find_or_initialize_by(user_id: user.id, device_id: device_id, database_id: database_id)
        return :ignored if report.persisted? && sequence <= report.sequence
        now = Time.current
        if attributes
          report.assign_attributes(attributes.except(:device_name).merge(sequence: sequence, reported_at: now, deleted_at: nil))
        else
          report.assign_attributes(sequence: sequence, reported_at: now, deleted_at: now, name: nil, size_bytes: nil,
            statement_count: nil, transaction_count: nil, rule_count: nil, period_start: nil, period_end: nil,
            modified_at: nil, opened_at: nil)
        end
        report.save!
        :applied
      end
    end

    # Removes everything a device reported, and remembers the sequence so older reports that
    # arrive afterwards are refused. Returns :applied or :ignored.
    def self.purge_device!(user:, device_id:, sequence:)
      user.with_lock do
        device = LocalDevice.find_or_initialize_by(user_id: user.id, device_id: device_id)
        return :ignored if device.persisted? && sequence <= device.purged_through
        device.purged_through = sequence
        device.name = nil
        device.save!
        where(user_id: user.id, device_id: device_id).delete_all
        :applied
      end
    end
  end
end
