# One sign-in, on the website ("web") or in an app ("app"). Signing out revokes the row, so every copy
# of that credential (a leaked token, a copied cookie) stops working at once; other sign-ins are separate
# rows and are not affected.
#
#   app  the bearer token itself (ClientApi::SessionToken)
#   web  a secret inside the encrypted session cookie (see User.serialize_into_session)
#
# Only the SHA-256 digest of the secret is stored. 256 random bits need no slow hash.
class UserSession < ApplicationRecord
  KINDS = %w[app web].freeze
  REASONS = %w[signed_out signed_out_elsewhere password_changed replaced].freeze
  LIFETIME = 30.days
  # Revoked and expired rows are kept this long after they end, then pruned when the person next signs in.
  RETENTION = 90.days
  TOUCH_EVERY = 5.minutes
  APP_PREFIX = "bwa_"
  DIGEST = /\A[0-9a-f]{64}\z/

  self.filter_attributes = [:token_digest, :credential_fingerprint]

  belongs_to :user

  validates :kind, inclusion: {in: KINDS}

  scope :active, -> { where(revoked_at: nil).where("user_sessions.expires_at > ?", Time.current) }

  class << self
    def digest(secret) = Digest::SHA256.hexdigest(secret.to_s)

    # Changes whenever the password does, even when it is written outside Rails, and is compared on every
    # request. A session opened with the old password can therefore never outlive it, whatever the timing.
    def fingerprint(user) = digest("user-session:#{user.id}:#{user.authenticatable_salt}")

    # [record, secret]. The secret is not stored anywhere on the server.
    def issue!(user, kind:)
      prune(user)
      secret = "#{APP_PREFIX if kind == "app"}#{SecureRandom.urlsafe_base64(32)}"
      record = create!(user_id: user.id, kind: kind, token_digest: digest(secret), credential_fingerprint: fingerprint(user), expires_at: LIFETIME.from_now)
      [record, secret]
    end

    # The live session for a secret, or nil. The caller still decides whether the account may sign in.
    def active_for(secret, kind:, user: nil)
      return nil unless secret.is_a?(String) && secret.length.between?(40, 100)
      record = active.find_by(token_digest: digest(secret), kind: kind)
      return nil unless record
      user ||= record.user
      return nil unless user && user.id == record.user_id
      return nil unless ActiveSupport::SecurityUtils.secure_compare(record.credential_fingerprint, fingerprint(user))
      record.association(:user).target = user
      record.touch_use
      record
    end

    def revoke_secret(secret, kind:, reason: "signed_out")
      return 0 unless secret.is_a?(String)
      revoke_digest(digest(secret), kind: kind, reason: reason)
    end

    # Knowing a digest allows ending that session and nothing else. The apps use it to finish a sign-out
    # that was made offline without keeping the token itself.
    def revoke_digest(token_digest, kind:, reason: "signed_out")
      return 0 unless token_digest.is_a?(String) && token_digest.match?(DIGEST)
      revoke_all_in(where(token_digest: token_digest, kind: kind), reason)
    end

    # Every sign-in of this account except `keep`. Remember-me cookies go too, or they would sign a
    # revoked browser straight back in. Returns how many live sessions ended.
    def revoke_all!(user, reason:, keep: nil)
      scope = where(user_id: user.id).where.not(id: keep&.id)
      live = transaction do
        count = scope.active.count
        revoke_all_in(scope, reason)
        user.update_columns(remember_created_at: nil) if user.remember_created_at
        count
      end
      ActiveRecord.after_all_transactions_commit { disconnect_live_updates(user) }
      live
    end

    # Open page connections authenticate only when they connect. Pages that are still signed in reconnect
    # by themselves. Best effort: a message broker problem must not stop a sign-out.
    def disconnect_live_updates(user)
      ActionCable.server.remote_connections.where(current_user: user).disconnect
    rescue => error
      Rails.logger.warn("Live update connections could not be closed: #{error.class}")
    end

    private

    # One conditional UPDATE, so concurrent sign-outs agree and the first reason is kept.
    def revoke_all_in(scope, reason)
      raise ArgumentError, reason unless REASONS.include?(reason)
      now = Time.current
      scope.where(revoked_at: nil).update_all(revoked_at: now, revoke_reason: reason, updated_at: now)
    end

    def prune(user)
      where(user_id: user.id).where("COALESCE(revoked_at, expires_at) < ?", RETENTION.ago).delete_all
    end
  end

  def revoke!(reason) = self.class.revoke_digest(token_digest, kind: kind, reason: reason)

  # Best effort and at most once per TOUCH_EVERY; it can never bring a revoked session back.
  def touch_use
    now = Time.current
    return if last_used_at && last_used_at > now - TOUCH_EVERY
    self.class.where(id: id, revoked_at: nil).update_all(last_used_at: now)
  end
end
