module Finance
  # A revocable token that lets an iOS Shortcut ("Hey Siri, scan a receipt with BillieWeather") send
  # one receipt at a time to this account. It can only create and read receipts through
  # ClientApi::V1::ReceiptsController — never list transactions, edit, delete or sign in.
  # Only the SHA-256 digest is stored; the token is shown once.
  class CaptureToken < ActiveRecord::Base
    self.table_name = "finance_capture_tokens"

    PREFIX = "bwc_"
    LIFETIME = 365.days
    MAX_ACTIVE = 5

    belongs_to :user

    validates :name, presence: true, length: {maximum: 60}
    validates :token_digest, format: {with: /\A[0-9a-f]{64}\z/}
    validate :active_limit, on: :create

    scope :active, -> { where(revoked_at: nil).where("expires_at > ?", Time.current) }

    def self.digest(token) = Digest::SHA256.hexdigest(token.to_s)

    # Returns [record, plaintext token]. The plaintext is not stored anywhere.
    def self.issue!(user:, name:)
      raise ArgumentError, "the Example Account cannot create capture tokens" if user.demo_account?
      token = "#{PREFIX}#{SecureRandom.urlsafe_base64(32)}"
      record = create!(user: user, name: name.to_s.strip.first(60), token_digest: digest(token), token_prefix: token.first(12), expires_at: LIFETIME.from_now)
      [record, token]
    end

    # The user for a valid, unrevoked, unexpired token (constant-time digest lookup), or nil.
    def self.authenticate(token)
      return nil unless token.to_s.start_with?(PREFIX) && token.to_s.length.between?(20, 100)
      record = active.find_by(token_digest: digest(token))
      return nil unless record
      user = record.user
      return nil if user.demo_account? || !user.active_for_authentication?
      record.update_column(:last_used_at, Time.current) if record.last_used_at.nil? || record.last_used_at < 1.minute.ago
      user
    end

    def revoke! = update!(revoked_at: Time.current)

    def active? = revoked_at.nil? && expires_at.future?

    private

    def active_limit
      errors.add(:base, :too_many) if user && CaptureToken.active.where(user_id: user.id).count >= MAX_ACTIVE
    end
  end
end
