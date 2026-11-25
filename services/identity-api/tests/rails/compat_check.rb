# Run by tests/test_compat.py through `bin/rails runner` against the LOCAL test database only.
# Input (JSON on ARGV[0]): accounts the Python service created, with their passwords.
# Output (JSON on stdout after a marker): what Rails/Devise think of each account.
require "json"

input = JSON.parse(File.read(ARGV.fetch(0)))
session = ActionDispatch::Integration::Session.new(Rails.application)
session.host! "www.example.com"

results = input.fetch("accounts").map do |account|
  user = User.find_by(email: account.fetch("email"))
  next {"email" => account["email"], "found" => false} unless user

  session.post "/api/client/v1/session", params: {email: account["email"].upcase, password: account["password"]}, as: :json
  login = session.response
  body = JSON.parse(login.body) rescue {}
  token = body["token"]
  me = nil
  if token
    session.get "/api/client/v1/account", headers: {"Authorization" => "Bearer #{token}"}
    me = JSON.parse(session.response.body)["account"] rescue nil
  end
  token_authenticates = token ? ClientApi::SessionToken.authenticate(token)&.id == user.id : false
  # Sign out: the server revokes the token for account and financial endpoints. Then sign in again.
  session.delete "/api/client/v1/session", headers: token ? {"Authorization" => "Bearer #{token}"} : {}
  logout_status = session.response.status
  after_logout = %w[/api/client/v1/account /api/client/v1/finance].map do |path|
    session.get path, headers: {"Authorization" => "Bearer #{token}"}
    session.response.status
  end
  session.post "/api/client/v1/session", params: {email: account["email"], password: account["password"]}, as: :json
  relogin_status = session.response.status
  membership = user.memberships.first
  {
    "email" => user.email,
    "found" => true,
    "valid" => user.valid?,
    "errors" => user.errors.full_messages,
    "valid_password" => user.valid_password?(account["password"]),
    "wrong_password_rejected" => !user.valid_password?(account["password"] + "x"),
    "active_for_authentication" => user.active_for_authentication?,
    "teams" => user.teams.count,
    "current_team_name" => user.current_team&.name,
    "admin" => membership&.admin? || false,
    "membership_email" => membership&.user_email,
    "google_uid" => user.google_uid,
    "needs_usage_region" => user.needs_usage_region?,
    "badges" => user.community_badges,
    "login_status" => login.status,
    "login_owner_id" => body.dig("account", "owner_id"),
    "db_owner_id" => user.finance_owner_uid,
    "account_endpoint_email" => me && me["email"],
    "account_endpoint_nickname" => me && me["nickname"],
    "logout_status" => logout_status,
    "relogin_status" => relogin_status,
    "token_authenticates" => token_authenticates,
    "after_logout" => after_logout
  }
end

# A Rails-created account for the Python service to recognize (duplicate + link checks).
reference = User.find_by(email: input.fetch("rails_reference_email")) || User.create!(
  email: input["rails_reference_email"], password: input["rails_reference_password"],
  password_confirmation: input["rails_reference_password"], usage_region: "US", nickname: "Rails Ref"
).tap(&:create_default_team)

puts "COMPAT_JSON:" + JSON.dump({"results" => results, "reference_id" => reference.id})
