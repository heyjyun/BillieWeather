# Remember the account after every real website sign-in (not on each request, which
# Warden reports as :fetch). See RememberedAccount; the demo account is skipped there.
Warden::Manager.after_set_user except: :fetch do |user, auth, opts|
  next unless opts[:scope] == :user
  request = ActionDispatch::Request.new(auth.env)
  RememberedAccount.remember(request.cookie_jar, user, secure: request.ssl?)
end
