# Server-side sign-ins for the website and the apps, so signing out is enforced by the server.
#
# Additive: no existing table changes, so it can run before the new code is deployed and the previous
# release keeps working on top of it. Only SHA-256 digests are stored, never a usable credential.
class CreateUserSessions < ActiveRecord::Migration[8.1]
  def change
    create_table :user_sessions do |t|
      t.references :user, null: false, foreign_key: {on_delete: :cascade}, index: false
      t.string :kind, null: false, limit: 8
      t.string :token_digest, null: false, limit: 64
      # Binds the session to the password it was opened with (see UserSession.fingerprint).
      t.string :credential_fingerprint, null: false, limit: 64
      t.datetime :expires_at, null: false
      t.datetime :last_used_at
      t.datetime :revoked_at
      t.string :revoke_reason, limit: 32
      t.timestamps
      t.index :token_digest, unique: true
      t.index [:user_id, :revoked_at]
      t.check_constraint "kind IN ('app', 'web')", name: "user_sessions_kind"
      t.check_constraint "token_digest ~ '^[0-9a-f]{64}$'", name: "user_sessions_digest"
      t.check_constraint "credential_fingerprint ~ '^[0-9a-f]{64}$'", name: "user_sessions_fingerprint"
      t.check_constraint "(revoked_at IS NULL) = (revoke_reason IS NULL)", name: "user_sessions_revocation"
      t.check_constraint "expires_at > created_at", name: "user_sessions_expiry"
    end
  end
end
