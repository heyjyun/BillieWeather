require "test_helper"

# Audit A-08 (four-agent audit 2026-11-25), withdrawn: receipt files use the PrivateDatabase storage
# service (Finance::Receipt has_one_attached :file, service: :private_database), so purging a file is a
# DELETE in the same PostgreSQL transaction and rolls back with it. These tests pin that: if receipts ever
# move to an external store (S3, Cloudinary), the first one fails and the purge must move after commit.
# Synthetic data only.
class Finance::DataDeletionFilesTest < ActiveSupport::TestCase
  setup do
    @user = create(:onboarded_user, usage_region: "US")
    Finance::Profile.find_or_create_by!(user_id: @user.id) { |profile| profile.currency = "USD" }
  end

  def receipt_with_file
    Finance::ReceiptIngestion.call(user: @user, source: "upload", file: {bytes: "%PDF-1.4 synthetic #{SecureRandom.hex(4)}", filename: "r.pdf", content_type: "application/pdf"},
      fields: {merchant_name: "Synthetic Deli", purchased_on: "2026-11-15", total: "12.00"}).receipt
  end

  test "a deletion that fails part-way keeps every receipt and its file" do
    receipt = receipt_with_file
    blob = receipt.file.blob
    failing = Object.new
    failing.define_singleton_method(:delete_all) { raise ActiveRecord::StatementInvalid, "synthetic failure" }
    original = Finance::Profile.method(:where)
    Finance::Profile.define_singleton_method(:where) { |*args, **kwargs| (kwargs.key?(:user_id) || args.first.is_a?(Hash)) ? failing : original.call(*args, **kwargs) }
    begin
      assert_raises(ActiveRecord::StatementInvalid) { Finance::DataDeletion.call(user: @user) }
    ensure
      Finance::Profile.define_singleton_method(:where, original)
    end
    assert Finance::Receipt.exists?(receipt.id)
    assert ActiveStorage::Blob.exists?(blob.id)
    assert receipt.reload.file.attached?
    assert blob.service.exist?(blob.key), "the stored file is still there"
  end

  test "a deletion that succeeds removes the receipts, their blobs and the stored files" do
    receipt = receipt_with_file
    blob = receipt.file.blob
    Finance::DataDeletion.call(user: @user)
    refute Finance::Receipt.exists?(receipt.id)
    refute ActiveStorage::Blob.exists?(blob.id)
    refute blob.service.exist?(blob.key)
  end
end
