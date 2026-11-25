module ClientApi
  # Bearer tokens for the desktop and mobile apps (clients/universal). Each token is one server-side
  # UserSession, checked on every request, so signing out, changing the password or signing out other
  # sessions takes effect at once.
  #
  # A token opens the account endpoints and the person's own web financial data (ClientApi::V1). The
  # signed, stateless tokens issued before UserSession existed could not be revoked and are refused;
  # those apps ask for one new sign-in and keep their local data.
  class SessionToken
    LIFETIME = UserSession::LIFETIME

    def self.issue(user)
      record, token = UserSession.issue!(user, kind: "app")
      [token, record.expires_at]
    end

    # The live session for a token, or nil (unknown, expired, revoked, password changed, or an account
    # that may not sign in).
    def self.session(token)
      record = UserSession.active_for(token, kind: "app")
      return nil unless record
      (record.user.platform_agent_of_id.nil? && record.user.active_for_authentication?) ? record : nil
    end

    def self.authenticate(token) = session(token)&.user
  end
end
