# Honor badges, private support-payment access, and admin-uploaded payment QR codes.
# Purely additive: no existing rows are changed or removed.
class CreateCommunitySupport < ActiveRecord::Migration[8.1]
  HONOR_KINDS = %w[founding_member founding_patron].freeze
  RECORDED_PAYMENT_METHODS = %w[alipay wechat_pay zelle venmo other].freeze
  PAYMENT_METHOD_KEYS = %w[alipay wechat_pay zelle venmo].freeze

  def change
    # Honorary badges. "Member" is implicit for every account and is not stored.
    # These are recognition only and deliberately separate from Bullet Train roles/permissions.
    create_table :community_honors do |t|
      t.references :user, null: false, foreign_key: {on_delete: :cascade}
      t.string :kind, null: false
      t.datetime :granted_at, null: false
      t.references :granted_by, foreign_key: {to_table: :users, on_delete: :nullify}
      # Founding Patron only: when an admin verified the external transfer, and through which service.
      t.datetime :confirmed_at
      t.string :payment_method
      # Admin-only notes. Never shown publicly. No amounts are stored.
      t.text :note
      t.datetime :revoked_at
      t.references :revoked_by, foreign_key: {to_table: :users, on_delete: :nullify}
      t.text :revoke_reason
      t.timestamps

      t.index [:user_id, :kind], unique: true, where: "revoked_at IS NULL", name: "index_community_honors_one_active_per_kind"
      t.check_constraint "kind IN (#{HONOR_KINDS.map { |kind| "'#{kind}'" }.join(", ")})", name: "community_honors_kind_allowed"
      t.check_constraint "payment_method IS NULL OR payment_method IN (#{RECORDED_PAYMENT_METHODS.map { |key| "'#{key}'" }.join(", ")})",
        name: "community_honors_payment_method_allowed"
      t.check_constraint "kind <> 'founding_patron' OR (confirmed_at IS NOT NULL AND payment_method IS NOT NULL)",
        name: "community_honors_patron_confirmed"
    end

    # Friends an admin has invited to see the personal payment QR codes.
    create_table :community_support_accesses do |t|
      t.references :user, null: false, foreign_key: {on_delete: :cascade}, index: {unique: true}
      t.datetime :granted_at, null: false
      t.references :granted_by, foreign_key: {to_table: :users, on_delete: :nullify}
      t.datetime :revoked_at
      t.references :revoked_by, foreign_key: {to_table: :users, on_delete: :nullify}
      t.timestamps
    end

    # QR images live in the database (not /public or a public Active Storage URL) and are
    # only ever served through an authorizing controller.
    create_table :community_payment_methods do |t|
      t.string :key, null: false, index: {unique: true}
      t.binary :qr_image
      t.string :qr_content_type
      t.integer :qr_byte_size
      t.boolean :note_supported, null: false, default: true
      t.references :updated_by, foreign_key: {to_table: :users, on_delete: :nullify}
      t.timestamps

      t.check_constraint "key IN (#{PAYMENT_METHOD_KEYS.map { |key| "'#{key}'" }.join(", ")})", name: "community_payment_methods_key_allowed"
    end

    # A Founding Patron's explicit choice to list their nickname publicly. Off by default.
    add_column :users, :supporter_recognition_public, :boolean, null: false, default: false
  end
end
