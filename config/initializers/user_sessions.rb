# Server-side website sessions (see UserSession). Rotation and sign-out hook into Warden so that every
# way in or out, including the ones inside Devise and Bullet Train, is covered.
module BillieReplacePreviousSession
  # Signing in again in the same browser, or refreshing its credentials, replaces the previous session.
  def store(user, scope)
    UserWebSession.revoke(self, scope, "replaced") if user
    super
  end
end
Warden::SessionSerializer.prepend(BillieReplacePreviousSession)

Warden::Manager.before_logout do |user, warden, options|
  revoked = UserWebSession.revoke(warden.session_serializer, options[:scope], "signed_out")
  UserSession.disconnect_live_updates(user) if user && revoked.positive?
end
