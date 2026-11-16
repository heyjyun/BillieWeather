# An immutable, opaque id the apps bind each local database to (docs/architecture/finance-domain-spec.md,
# invariant I-13). Emails can change; this never does. Additive: existing users get a random uuid.
class AddFinanceOwnerUidToUsers < ActiveRecord::Migration[8.1]
  def change
    enable_extension "pgcrypto" unless extension_enabled?("pgcrypto")
    add_column :users, :finance_owner_uid, :uuid, null: false, default: -> { "gen_random_uuid()" }
    add_index :users, :finance_owner_uid, unique: true
  end
end
