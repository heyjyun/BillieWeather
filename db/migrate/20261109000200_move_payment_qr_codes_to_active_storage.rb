# Payment QR codes move from a bytea column to Active Storage, on a private,
# database-backed service (see lib/active_storage/service/private_database_service.rb).
# The database is the only persistent storage on the hosting plan, and files kept
# here have no public URL. Each payment method also gets an admin on/off switch,
# off by default.
class MovePaymentQrCodesToActiveStorage < ActiveRecord::Migration[8.1]
  def up
    # Refuse to drop QR images silently. None exist yet; if some do, re-upload them on
    # Admin → Payment Methods after clearing them by hand.
    if select_value("SELECT COUNT(*) FROM community_payment_methods WHERE qr_image IS NOT NULL").to_i.positive?
      raise ActiveRecord::IrreversibleMigration, "community_payment_methods still holds QR images; clear them before migrating."
    end

    create_table :private_storage_files do |t|
      t.string :key, null: false, index: {unique: true}
      t.binary :data, null: false
      t.bigint :byte_size, null: false
      t.timestamps
    end

    add_column :community_payment_methods, :enabled, :boolean, null: false, default: false
    remove_column :community_payment_methods, :qr_image
    remove_column :community_payment_methods, :qr_content_type
    remove_column :community_payment_methods, :qr_byte_size
  end

  # Mirrors `up`: refuse to drop stored files silently. private_storage_files also holds every file
  # stored later on the private database service (receipt images and PDFs, 20261117000100), and the
  # old bytea columns cannot take them back, so a rollback over stored files would lose them for good.
  # Export or remove them first (Admin → Payment Methods; "Delete my financial data" for receipts).
  def down
    if select_value("SELECT COUNT(*) FROM private_storage_files").to_i.positive?
      raise ActiveRecord::IrreversibleMigration, "private_storage_files still holds stored files (payment QR codes, receipts); " \
        "rolling back would delete them. Remove them deliberately before migrating down."
    end

    add_column :community_payment_methods, :qr_byte_size, :integer
    add_column :community_payment_methods, :qr_content_type, :string
    add_column :community_payment_methods, :qr_image, :binary
    remove_column :community_payment_methods, :enabled
    drop_table :private_storage_files
  end
end
