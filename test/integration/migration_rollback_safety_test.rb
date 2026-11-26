require "test_helper"
require Rails.root.join("db/migrate/20261109000200_move_payment_qr_codes_to_active_storage")

# Rolling back a migration must never delete stored files without being told to (C-11). Everything here
# runs inside the test transaction (PostgreSQL DDL is transactional), so the schema is unchanged afterwards.
class MigrationRollbackSafetyTest < ActiveSupport::TestCase
  def roll_back_qr_migration
    ActiveRecord::Migration.suppress_messages { MovePaymentQrCodesToActiveStorage.new.migrate(:down) }
  ensure
    [PrivateStorageFile, Community::PaymentMethod].each(&:reset_column_information)
  end

  test "rolling back the QR move refuses while private files are stored, and keeps them" do
    PrivateStorageFile.create!(key: "synthetic-#{SecureRandom.hex(4)}", data: "%PDF-1.4 synthetic".b, byte_size: 18)
    error = assert_raises(ActiveRecord::IrreversibleMigration) do
      ActiveRecord::Base.transaction(requires_new: true) { roll_back_qr_migration }
    end
    assert_match(/private_storage_files still holds stored files/, error.message)
    assert ActiveRecord::Base.connection.table_exists?(:private_storage_files)
    assert_equal 1, PrivateStorageFile.count
  end

  test "rolling back the QR move with nothing stored still works" do
    assert_equal 0, PrivateStorageFile.count
    ActiveRecord::Base.transaction(requires_new: true) do
      roll_back_qr_migration
      refute ActiveRecord::Base.connection.table_exists?(:private_storage_files)
      assert ActiveRecord::Base.connection.column_exists?(:community_payment_methods, :qr_image)
      raise ActiveRecord::Rollback
    end
    assert ActiveRecord::Base.connection.table_exists?(:private_storage_files)
  end
end
