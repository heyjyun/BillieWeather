# Server-side website sessions (see UserSession). Rotation and sign-out hook into Warden so that every
# way in or out, including the ones inside Devise and Bullet Train, is covered.
module BillieReplacePreviousSession
  # One browser holds one session. Refreshing the same person's credentials (saving a profile) keeps it: a new
  # secret would sign out whatever the browser is loading at that moment. Anything else replaces it.
  def store(user, scope)
    return super unless user&.respond_to?(:user_sessions)
    kept = UserWebSession.secret(self, scope)
    if UserSession.active_for(kept, kind: "web", user: user)
      session[key_for(scope)] = [user.to_key, user.authenticatable_salt, kept]
    else
      UserWebSession.revoke(self, scope, "replaced")
      super
    end
  end
end
Warden::SessionSerializer.prepend(BillieReplacePreviousSession)

Warden::Manager.before_logout do |user, warden, options|
  revoked = UserWebSession.revoke(warden.session_serializer, options[:scope], "signed_out")
  UserSession.disconnect_live_updates(user) if user && revoked.positive?
end
