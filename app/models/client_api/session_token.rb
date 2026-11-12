module ClientApi
  # Bearer tokens for the desktop and mobile apps (clients/universal).
  #
  # Signed and time-limited, so no new table is needed. A token carries the user's
  # Devise authenticatable salt, so changing the password signs out every app. The
  # token only grants access to the account endpoints in ClientApi::V1 — never to
  # financial data, which the apps keep on the device.
  class SessionToken
    LIFETIME = 30.days
    PURPOSE = :client_api_session

    def self.issue(user)
      raise ArgumentError, "the Example Account cannot use the apps" if user.demo_account?
      expires_at = LIFETIME.from_now
      token = verifier.generate({"uid" => user.id, "salt" => user.authenticatable_salt}, expires_at: expires_at, purpose: PURPOSE)
      [token, expires_at]
    end

    # The user for a valid token, or nil (expired, tampered, password changed, locked or deleted account).
    def self.authenticate(token)
      payload = verifier.verified(token.to_s, purpose: PURPOSE)
      return nil unless payload.is_a?(Hash)
      user = User.find_by(id: payload["uid"], platform_agent_of_id: nil)
      # The website-only Example Account never gets app access (it has no password to sign in
      # with either); the apps keep real financial data on the device.
      return nil if user&.demo_account?
      return nil unless user && ActiveSupport::SecurityUtils.secure_compare(user.authenticatable_salt.to_s, payload["salt"].to_s)
      user.active_for_authentication? ? user : nil
    end

    def self.verifier
      Rails.application.message_verifier("client_api_session")
    end
  end
end
