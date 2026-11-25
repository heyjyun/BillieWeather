# The website half of UserSession: reads the session secret out of Warden's cookie data.
module UserWebSession
  # The secret the browser's cookie holds for a scope, or nil.
  def self.secret(serializer, scope = :user)
    value = serializer.session[serializer.key_for(scope)]
    value[2] if value.is_a?(Array)
  end

  def self.current(warden, scope = :user)
    UserSession.active_for(secret(warden.session_serializer, scope), kind: "web")
  end

  def self.revoke(serializer, scope, reason)
    UserSession.revoke_secret(secret(serializer, scope), kind: "web", reason: reason)
  end
end
