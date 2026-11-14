# Local database cards: one per (account, device). Additive only: nothing is deleted and no
# existing row changes meaning. Legacy rows are consolidated separately (and only on request)
# by `bin/rails billie:local_databases:consolidate`, which runs as a dry run by default.
class AddIdentityAndReviewToLocalDatabases < ActiveRecord::Migration[8.1]
  def change
    change_table :finance_local_devices, bulk: true do |t|
      # Set by apps that report with a stable, file-based device id ("macos", "windows", …).
      # Devices without it only ever reported through the old, unstable identity.
      t.string :platform, limit: 16
      # A name the person chose on the website for this card. Never sent to the device.
      t.string :label, limit: 80
      t.datetime :last_reported_at
    end

    change_table :finance_local_database_reports, bulk: true do |t|
      # active: shown as part of the device's card. review: kept, shown only in the review list.
      # archived: an obsolete snapshot, kept for the audit trail and never shown as a card.
      t.string :status, limit: 16, null: false, default: "active"
      t.string :status_reason, limit: 40
      t.datetime :status_changed_at
      # When the person last ran an explicit "Sync Now" in the app (reported, never inferred).
      t.datetime :synced_at
    end
    add_index :finance_local_database_reports, [:user_id, :database_id], name: "index_local_database_reports_on_owner_database"

    # What happened to whom and why: identity changes, consolidations, review decisions.
    create_table :finance_local_database_audits do |t|
      t.references :user, null: false, foreign_key: {on_delete: :cascade}, index: true
      t.string :device_id, limit: 36
      t.string :database_id, limit: 36
      t.string :event, limit: 40, null: false
      t.jsonb :details, null: false, default: {}
      t.datetime :created_at, null: false
    end
  end
end
