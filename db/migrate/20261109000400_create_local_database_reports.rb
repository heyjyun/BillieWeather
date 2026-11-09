class CreateLocalDatabaseReports < ActiveRecord::Migration[8.1]
  def change
    # One row per app installation that has reported. Holds only the device's display name and
    # the highest "purge" sequence number the server accepted, so a late, older report from
    # the same device cannot bring back information the person asked to remove.
    create_table :finance_local_devices do |t|
      t.references :user, null: false, foreign_key: {on_delete: :cascade}
      t.string :device_id, null: false, limit: 36
      t.string :name, limit: 80
      t.bigint :purged_through, null: false, default: 0
      t.timestamps
      t.index [:user_id, :device_id], unique: true
    end

    # Metadata about one database on a device: names, size and counts. NEVER financial
    # content. A deleted database keeps a tombstone (deleted_at set, details cleared) so that
    # an older report arriving late cannot make its card reappear.
    create_table :finance_local_database_reports do |t|
      t.references :user, null: false, foreign_key: {on_delete: :cascade}
      t.string :device_id, null: false, limit: 36
      t.string :database_id, null: false, limit: 36
      t.string :name, limit: 60
      t.bigint :size_bytes
      t.integer :statement_count
      t.integer :transaction_count
      t.integer :rule_count
      t.date :period_start
      t.date :period_end
      t.datetime :modified_at
      t.datetime :opened_at
      t.bigint :sequence, null: false
      t.datetime :reported_at, null: false # when the server received it, never the device's clock
      t.datetime :deleted_at
      t.timestamps
      t.index [:user_id, :device_id, :database_id], unique: true, name: "index_local_database_reports_on_owner_device_database"
    end
  end
end
