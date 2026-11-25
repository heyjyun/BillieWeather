require "test_helper"

# Signing out is enforced by the server: a copy of a credential taken before sign-out (a leaked app
# token, a copied browser cookie) must stop working at once, and other sign-ins must not notice.
class SessionRevocationTest < ActionDispatch::IntegrationTest
  PASSWORD = "a-long-test-password-1"
  NEW_PASSWORD = "another-long-password-2"

  # Every bearer-token endpoint the apps call.
  PROTECTED = [
    [:get, "/api/client/v1/account"], [:patch, "/api/client/v1/account"],
    [:get, "/api/client/v1/finance"], [:patch, "/api/client/v1/finance"], [:delete, "/api/client/v1/finance"],
    [:get, "/api/client/v1/finance/statements"], [:post, "/api/client/v1/finance/statements"], [:delete, "/api/client/v1/finance/statements/1"],
    [:get, "/api/client/v1/finance/transactions"], [:get, "/api/client/v1/finance/rules"], [:get, "/api/client/v1/finance/categories"],
    [:post, "/api/client/v1/finance/categorize"], [:post, "/api/client/v1/finance/receipts"], [:get, "/api/client/v1/finance/receipts/1"],
    [:put, "/api/client/v1/devices/1/databases/1"], [:delete, "/api/client/v1/devices/1/databases/1"], [:delete, "/api/client/v1/devices/1"],
    [:delete, "/api/client/v1/sessions"]
  ].freeze

  setup do
    @user = create(:onboarded_user, email: "revoke@example.com", nickname: "jyun", password: PASSWORD, password_confirmation: PASSWORD, usage_region: "US")
    @other = create(:onboarded_user, email: "other-revoke@example.com", nickname: "other", password: PASSWORD, password_confirmation: PASSWORD, usage_region: "US")
  end

  def app_token(user = @user, password: PASSWORD)
    post "/api/client/v1/session", params: {email: user.email, password: password}, as: :json
    assert_response :created
    response.parsed_body.fetch("token")
  end

  def auth(token) = {"Authorization" => "Bearer #{token}"}

  def app_status(token, path = "/api/client/v1/account")
    open_session { |client| client.get(path, headers: auth(token), as: :json) }.response.status
  end

  # A browser of its own, signed in through the website form.
  def browser(user = @user, password: PASSWORD, remember: false)
    open_session do |client|
      client.post user_session_path, params: {user: {email: user.email, password: password, remember_me: remember ? "1" : "0"}}
      assert client.response.redirect?, "website sign-in failed"
    end
  end

  def browser_status(client)
    client.get finance_dashboard_path
    client.response.status
  end

  # A second browser holding copies of every cookie, as after a cookie theft.
  def copy_of(client)
    jar = client.cookies.to_hash
    open_session { |thief| jar.each { |name, value| thief.cookies[name] = value } }
  end

  # --- Apps -------------------------------------------------------------------------------------

  test "signing out of the app revokes exactly that token, everywhere" do
    stolen = app_token
    kept = app_token
    others = app_token(@other)
    assert_equal 200, app_status(stolen)

    delete "/api/client/v1/session", headers: auth(stolen), as: :json
    assert_response :no_content

    PROTECTED.each do |verb, path|
      public_send(verb, path, headers: auth(stolen), as: :json)
      assert_response :unauthorized, "#{verb} #{path} accepted a revoked token"
      assert_equal "unauthorized", response.parsed_body["error"]
    end
    assert_equal 200, app_status(kept), "another signed-in app keeps working"
    assert_equal 200, app_status(kept, "/api/client/v1/finance")
    assert_equal 200, app_status(others)
  end

  test "every client API route is covered by the revocation check" do
    public_routes = [["POST", "/api/client/v1/session"], ["DELETE", "/api/client/v1/session"], ["POST", "/api/client/v1/session/revocations"]]
    routes = Rails.application.routes.routes.filter_map do |route|
      path = route.path.spec.to_s.delete_suffix("(.:format)").gsub(/:\w+/, "1")
      [route.verb, path] if path.start_with?("/api/client/v1")
    end.uniq - public_routes
    covered = PROTECTED.map { |verb, path| [verb.to_s.upcase, path] }
    # PUT is the alias Rails adds next to PATCH for singular resources; module preferences have their
    # own suite and answer 404 while the feature is off.
    uncovered = routes - covered - [["PUT", "/api/client/v1/account"]]
    assert_equal [], uncovered.reject { |_verb, path| path.end_with?("/module_preferences") }
  end

  test "sign-out is idempotent, and safe with garbage, another purpose's secret, or no token" do
    token = app_token
    3.times do
      delete "/api/client/v1/session", headers: auth(token), as: :json
      assert_response :no_content
    end
    [nil, "", "garbage", "bwa_short", "x" * 5000].each do |value|
      delete "/api/client/v1/session", headers: value ? auth(value) : {}, as: :json
      assert_response :no_content
      assert_equal 401, app_status(value)
    end
    assert_equal 1, UserSession.where(user: @user, kind: "app").count
    assert_equal "signed_out", UserSession.find_by!(user: @user, kind: "app").revoke_reason
  end

  test "a sign-out made offline is completed later from the token's digest alone" do
    token = app_token
    digest = Digest::SHA256.hexdigest(token)
    assert_equal 401, app_status(digest), "the digest must not be a credential"

    2.times do
      post "/api/client/v1/session/revocations", params: {token_digest: digest}, as: :json
      assert_response :no_content
    end
    assert_equal 401, app_status(token)
  end

  test "digest revocation reveals nothing and reaches only the named app session" do
    token = app_token
    web = browser
    web_digest = UserSession.find_by!(user: @user, kind: "web").token_digest
    ["", "nope", "0" * 64, web_digest, ["a"], {"a" => 1}].each do |value|
      post "/api/client/v1/session/revocations", params: {token_digest: value}, as: :json
      assert_response :no_content
    end
    post "/api/client/v1/session/revocations", as: :json
    assert_response :no_content
    assert_equal 200, app_status(token)
    assert_equal 200, browser_status(web)
  end

  test "revocation survives a restart because it is stored, and only digests are stored" do
    token = app_token
    row = UserSession.find_by!(user: @user, kind: "app")
    assert_equal Digest::SHA256.hexdigest(token), row.token_digest
    stored = UserSession.connection.select_one("SELECT * FROM user_sessions WHERE id = #{row.id}").values.join("|")
    assert_not_includes stored, token
    assert_not_includes stored, @user.encrypted_password
    assert_not_includes stored, @user.authenticatable_salt

    row.revoke!("signed_out")
    Rails.cache.clear
    UserSession.connection.clear_query_cache
    assert_equal 401, app_status(token)
  end

  test "tokens from before server-side sessions are refused" do
    legacy = Rails.application.message_verifier("client_api_session")
      .generate({"uid" => @user.id, "salt" => @user.authenticatable_salt}, expires_at: 30.days.from_now, purpose: :client_api_session)
    assert_equal 401, app_status(legacy)
    assert_equal 401, app_status(legacy, "/api/client/v1/finance")
  end

  test "expired tokens are refused" do
    token = app_token
    travel UserSession::LIFETIME - 1.minute do
      assert_equal 200, app_status(token)
    end
    travel UserSession::LIFETIME + 1.minute do
      assert_equal 401, app_status(token)
    end
  end

  test "a website session secret is not an app token and the other way round" do
    browser
    web = UserSession.issue!(@user, kind: "web").last
    app = UserSession.issue!(@user, kind: "app").last
    assert_equal 401, app_status(web)
    assert_nil UserSession.active_for(app, kind: "web")
    assert_equal @user.id, UserSession.active_for(app, kind: "app").user_id
  end

  test "a locked or deleted account's token stops working" do
    token = app_token
    @user.lock_access!(send_instructions: false)
    assert_equal 401, app_status(token)
    @user.unlock_access!
    assert_equal 200, app_status(token)
    UserSession.where(user: @other).delete_all
    other_token = app_token(@other)
    User.find(@other.id).destroy!
    assert_equal 401, app_status(other_token)
    assert_empty UserSession.where(user_id: @other.id)
  end

  # --- Website ----------------------------------------------------------------------------------

  test "signing out of the website makes a copied cookie useless" do
    client = browser
    thief = copy_of(client)
    assert_equal 200, browser_status(thief)
    token = app_token
    elsewhere = browser

    client.delete destroy_user_session_path
    assert_equal 302, browser_status(thief), "the copied cookie still opens financial pages"
    thief.get finance_transactions_path
    assert_equal 302, thief.response.status
    assert_equal 200, browser_status(elsewhere), "another browser stays signed in"
    assert_equal 200, app_status(token), "the app stays signed in"
  end

  test "cookies from before server-side sessions are refused without breaking public pages" do
    client = browser
    UserSession.where(user: @user).delete_all
    assert_equal 302, browser_status(client)
    client.get billie_home_path
    assert_equal 200, client.response.status
  end

  test "refreshing a browser's credentials keeps its one session, and sign-out still ends every copy" do
    client = browser
    thief = copy_of(client)
    client.patch account_user_path(@user), params: {user: {time_zone: "Tokyo"}}
    assert_equal 200, browser_status(client)
    assert_equal 1, UserSession.where(user: @user, kind: "web").count
    client.delete destroy_user_session_path
    assert_equal 302, browser_status(thief)
  end

  test "another person signing in with the same browser replaces the previous session" do
    client = browser
    thief = copy_of(client)
    env = {"rack.session" => {"warden.user.user.key" => [[@user.id], @user.authenticatable_salt, UserSession.issue!(@user, kind: "web").last]}}
    serializer = Warden::SessionSerializer.new(env)
    Devise.mappings # the warden serializers are defined with the routes
    serializer.store(@other, :user)
    assert_equal [@other.id], env["rack.session"]["warden.user.user.key"][0]
    assert_equal ["replaced"], UserSession.where(user: @user).where.not(revoked_at: nil).pluck(:revoke_reason)
    assert_equal 200, browser_status(thief), "a different session of the same person is not affected"
  end

  # --- Account-wide -----------------------------------------------------------------------------

  test "changing the password on the website signs out everything else and keeps this browser" do
    token = app_token
    elsewhere = browser(remember: true)
    others = app_token(@other)
    client = browser
    thief = copy_of(client)

    client.patch password_finance_settings_path, params: {user: {current_password: PASSWORD, password: NEW_PASSWORD, password_confirmation: NEW_PASSWORD}}
    assert_equal 303, client.response.status
    assert_equal 200, browser_status(client), "the browser that changed the password stays signed in"
    assert_equal 302, browser_status(thief), "its old cookie does not"
    assert_equal 302, browser_status(elsewhere), "neither the session nor the remember-me cookie survives"
    assert_equal 401, app_status(token)
    assert_equal 200, app_status(others)
    assert_equal 200, app_status(app_token(@user, password: NEW_PASSWORD))
  end

  test "resetting the password by email signs out everything" do
    token = app_token
    client = browser
    raw = @user.send(:set_reset_password_token)
    put user_password_path, params: {user: {reset_password_token: raw, password: NEW_PASSWORD, password_confirmation: NEW_PASSWORD}}
    assert_equal 401, app_status(token)
    assert_equal 302, browser_status(client)
    assert_equal ["password_changed"], UserSession.where(user: @user).where.not(revoked_at: nil).distinct.pluck(:revoke_reason)
  end

  test "a password written outside Rails still invalidates every session" do
    token = app_token
    client = browser
    @user.update_column(:encrypted_password, Devise::Encryptor.digest(User, NEW_PASSWORD))
    assert_equal 401, app_status(token)
    assert_equal 302, browser_status(client)
  end

  test "a sign-in that raced a password change does not outlive it" do
    stale = User.find(@user.id) # the sign-in request verified the old password…
    @user.update!(password: NEW_PASSWORD, password_confirmation: NEW_PASSWORD) # …then the password changed
    _record, token = UserSession.issue!(stale, kind: "app") # …and only then the token was written
    assert_equal 401, app_status(token)
  end

  test "the app can sign out every other session and stays signed in itself" do
    current = app_token
    lost = app_token
    client = browser(remember: true)
    others = app_token(@other)
    delete "/api/client/v1/sessions", headers: auth(current), as: :json
    assert_response :success
    assert_equal 2, response.parsed_body["revoked"]
    assert_equal 200, app_status(current)
    assert_equal 401, app_status(lost)
    assert_equal 302, browser_status(client), "remember-me must not sign the browser back in"
    assert_equal 200, app_status(others), "another account is untouched"
    delete "/api/client/v1/sessions", headers: auth(current), as: :json
    assert_equal 0, response.parsed_body["revoked"]
    delete "/api/client/v1/sessions", as: :json
    assert_response :unauthorized
  end

  test "the website can sign out every other session and stays signed in itself" do
    token = app_token
    elsewhere = browser
    client = browser
    client.get finance_settings_path
    assert_includes client.response.body, 'id="settings-sessions"'
    client.delete sessions_finance_settings_path
    assert_equal 303, client.response.status
    assert_equal 200, browser_status(client)
    assert_equal 302, browser_status(elsewhere)
    assert_equal 401, app_status(token)
  end

  test "changing other account details keeps every session" do
    token = app_token
    client = browser
    patch "/api/client/v1/account", params: {account: {nickname: "Renamed"}}, headers: auth(token), as: :json
    assert_response :success
    @user.reload.update!(time_zone: "Tokyo")
    assert_equal 200, app_status(token)
    assert_equal 200, browser_status(client)
  end

  test "open page connections are closed, and a broker failure does not stop the sign-out" do
    closed = []
    remote = Object.new
    remote.define_singleton_method(:where) do |identifiers|
      closed << identifiers
      self
    end
    remote.define_singleton_method(:disconnect) { |**| raise "broker down" if closed.size > 1 }
    server = ActionCable.server
    server.define_singleton_method(:remote_connections) { remote }
    browser
    UserSession.revoke_all!(@user, reason: "signed_out_elsewhere")
    assert_equal [{current_user: @user}], closed
    client = browser
    client.delete destroy_user_session_path
    assert client.response.redirect?
    assert_equal 2, closed.size
    assert_equal 0, UserSession.active.where(user: @user, kind: "web").count
  ensure
    server.singleton_class.remove_method(:remote_connections)
  end

  # --- Housekeeping -----------------------------------------------------------------------------

  test "long-dead sessions are pruned at sign-in, recent revocations are kept for audit" do
    old = UserSession.issue!(@user, kind: "app").first
    recent = UserSession.issue!(@user, kind: "app").first
    travel(-(UserSession::LIFETIME + UserSession::RETENTION + 1.day)) { @ancient = UserSession.issue!(@user, kind: "app").first }
    [old, recent].each { |row| row.revoke!("signed_out") }
    app_token
    assert_not UserSession.exists?(@ancient.id)
    assert UserSession.exists?(old.id)
    assert UserSession.exists?(recent.id)
  end

  test "last use is recorded without writing on every request" do
    token = app_token
    row = UserSession.find_by!(user: @user, kind: "app")
    assert_equal 200, app_status(token)
    first = row.reload.last_used_at
    assert first
    assert_equal 200, app_status(token)
    assert_equal first, row.reload.last_used_at
    travel 6.minutes do
      assert_equal 200, app_status(token)
      assert_operator row.reload.last_used_at, :>, first
    end
  end

  test "tokens and digests are filtered from logs" do
    filter = ActiveSupport::ParameterFilter.new(Rails.application.config.filter_parameters)
    assert_equal({"token_digest" => "[FILTERED]", "token" => "[FILTERED]"}, filter.filter("token_digest" => "abc", "token" => "x"))
    assert_not_includes UserSession.issue!(@user, kind: "app").first.inspect, UserSession.last.token_digest
  end
end
