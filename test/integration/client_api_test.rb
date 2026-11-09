require "test_helper"

# Account API used by the desktop and mobile apps.
class ClientApiTest < ActionDispatch::IntegrationTest
  PASSWORD = "a-long-test-password-1"

  setup do
    @user = create(:onboarded_user, email: "app-user@example.com", nickname: "jyun", password: PASSWORD, password_confirmation: PASSWORD, usage_region: "US", locale: "zh-CN")
  end

  def sign_in_json(email: @user.email, password: PASSWORD, **extra)
    post "/api/client/v1/session", params: {email: email, password: password, **extra}, as: :json
    response.parsed_body
  end

  def auth(token) = {"Authorization" => "Bearer #{token}"}

  test "signs in with email and password and returns a token plus account info only" do
    body = sign_in_json(email: " App-User@Example.com ")
    assert_response :created
    assert_includes response.headers["Cache-Control"], "no-store"
    assert body["token"].present?
    assert Time.iso8601(body["expires_at"]) > 29.days.from_now
    account = body["account"]
    assert_equal({"email" => "app-user@example.com", "nickname" => "jyun", "locale" => "zh-CN", "usage_region" => "US"},
      account.slice("email", "nickname", "locale", "usage_region"))
    assert_equal @user.created_at.iso8601, account["registered_at"]
    assert_equal ["member"], account["badges"]
    # Never financial data.
    assert_equal %w[badges email locale nickname registered_at time_zone usage_region], account.keys.sort
  end

  test "wrong password, unknown email, and missing fields are refused" do
    assert_equal "invalid_credentials", sign_in_json(password: "nope")["error"]
    assert_response :unauthorized
    assert_equal "invalid_credentials", sign_in_json(email: "nobody@example.com")["error"]
    post "/api/client/v1/session", params: {email: @user.email}, as: :json
    assert_response :bad_request
  end

  test "failed attempts count toward the normal account lockout" do
    @user.update_columns(failed_attempts: Devise.maximum_attempts - 1)
    sign_in_json(password: "wrong")
    assert @user.reload.access_locked?
    assert_equal "locked", sign_in_json["error"], "even the right password is refused while locked"
  end

  test "reads and updates language, nickname, and time zone with the token" do
    token = sign_in_json["token"]
    get "/api/client/v1/account", headers: auth(token), as: :json
    assert_response :success
    assert_equal "jyun", response.parsed_body.dig("account", "nickname")

    patch "/api/client/v1/account", params: {account: {locale: "ja", nickname: "Billie Fan", time_zone: "Tokyo"}}, headers: auth(token), as: :json
    assert_response :success
    assert_equal ["ja", "Billie Fan", "Tokyo"], [@user.reload.locale, @user.nickname, @user.time_zone]

    patch "/api/client/v1/account", params: {account: {locale: "klingon"}}, headers: auth(token), as: :json
    assert_response :unprocessable_content
    patch "/api/client/v1/account", params: {account: {time_zone: "Mars/Olympus"}}, headers: auth(token), as: :json
    assert_response :unprocessable_content
    # Only these three fields can change.
    patch "/api/client/v1/account", params: {account: {email: "evil@example.com", usage_region: "CN"}}, headers: auth(token), as: :json
    assert_equal ["app-user@example.com", "US"], [@user.reload.email, @user.usage_region]
  end

  test "missing, tampered, or stale tokens are refused" do
    get "/api/client/v1/account", as: :json
    assert_response :unauthorized
    get "/api/client/v1/account", headers: auth("garbage"), as: :json
    assert_response :unauthorized

    token = sign_in_json["token"]
    travel ClientApi::SessionToken::LIFETIME + 1.minute do
      get "/api/client/v1/account", headers: auth(token), as: :json
      assert_response :unauthorized
    end

    # Changing the password signs out every app.
    @user.update!(password: "another-long-password-2", password_confirmation: "another-long-password-2")
    get "/api/client/v1/account", headers: auth(token), as: :json
    assert_response :unauthorized
  end

  test "the apps' origins may call the API across origins" do
    process :options, "/api/client/v1/session", headers: {"Origin" => "tauri://localhost", "Access-Control-Request-Method" => "POST", "Access-Control-Request-Headers" => "content-type"}
    assert_equal "tauri://localhost", response.headers["Access-Control-Allow-Origin"]
    assert_includes response.headers["Access-Control-Allow-Methods"], "PATCH"
  end

  test "sign out succeeds (the app discards its token)" do
    delete "/api/client/v1/session", as: :json
    assert_response :no_content
  end
end
