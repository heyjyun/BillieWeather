require "test_helper"

class ClientApiModulePreferencesTest < ActionDispatch::IntegrationTest
  include Devise::Test::IntegrationHelpers
  PATH = "/api/client/v1/module_preferences"
  DEVICE_A = "1d7f90b9-bd34-4a5c-aa09-6ff7fe4ccc63"
  DEVICE_B = "2b58246f-e134-4b39-8a7a-fa2677174365"

  setup do
    @prior_flag = ENV["BILLIE_MODULE_SYNC"]
    ENV["BILLIE_MODULE_SYNC"] = "1"
    @user = create(:onboarded_user, usage_region: "US")
    @other = create(:onboarded_user, usage_region: "US")
    @auth = headers_for(@user)
  end

  teardown { ENV["BILLIE_MODULE_SYNC"] = @prior_flag }

  def headers_for(user)
    token, = ClientApi::SessionToken.issue(user)
    {"Authorization" => "Bearer #{token}"}
  end

  def change(key, visible, revision = 0)
    {module_key: key, sidebar_visible: visible, expected_revision: revision}
  end

  # What apps released before 2026-11-26 send: the same choice under the legacy name.
  def legacy_change(key, visible, revision = 0)
    {module_key: key, enabled: visible, expected_revision: revision}
  end

  def request_body(*changes, device: DEVICE_A, id: SecureRandom.uuid, version: 0)
    {format: 2, device_id: device, mutation_id: id, base_server_revision: version, changes: changes}
  end

  def send_update(body, headers: @auth)
    put PATH, params: body, as: :json, headers: headers
    response.parsed_body
  end

  test "authorization and rollout flag" do
    get PATH
    assert_response :unauthorized
    send_update(request_body(change("budgets", true)), headers: {})
    assert_response :unauthorized
    ENV["BILLIE_MODULE_SYNC"] = "0"
    get PATH, headers: @auth
    assert_response :not_found
    put PATH, headers: @auth, as: :json, params: request_body(change("budgets", true))
    assert_response :not_found
  end

  test "preflight allows the native WebView origin and excludes arbitrary origins" do
    headers = {"Access-Control-Request-Method" => "PUT", "Access-Control-Request-Headers" => "authorization,content-type"}
    options PATH, headers: headers.merge("Origin" => "tauri://localhost")
    assert_equal "tauri://localhost", response.headers["Access-Control-Allow-Origin"]
    options PATH, headers: headers.merge("Origin" => "https://other.example.invalid")
    assert_nil response.headers["Access-Control-Allow-Origin"]
  end

  test "an explicit legacy value belongs to its account and another account keeps its defaults" do
    Finance::ModulePreference.set!(user: @user, module_key: "budgets", sidebar_visible: true)
    get PATH, headers: @auth
    assert_response :ok
    assert_equal @user.finance_owner_uid, response.parsed_body["account_id"]
    assert_equal 1, response.parsed_body["server_revision"]
    assert_equal [["budgets", true, true]], response.parsed_body.fetch("modules").map { |key, choice| [key, choice.fetch("sidebar_visible"), choice.fetch("enabled")] },
      "both names carry the sidebar choice, for current and older apps"
    assert_equal "no-store", response.headers["Cache-Control"]
    get PATH, params: {account_id: @user.finance_owner_uid}, headers: headers_for(@other)
    assert_equal @other.finance_owner_uid, response.parsed_body["account_id"]
    assert_empty response.parsed_body["modules"]
  end

  test "a website reset preserves app-only choices and a second device sees the restored defaults" do
    sign_in @user
    send_update(request_body(change("data_management", true), change("ai_assistant", false), change("import", true)))
    assert_response :ok
    assert_equal %w[ai_assistant data_management import], response.parsed_body.fetch("applied")
    post finance_reset_feature_library_path
    assert_redirected_to finance_feature_library_path
    get PATH, headers: headers_for(@user)
    assert_response :ok
    assert_equal [true, 1], response.parsed_body.dig("modules", "data_management").values_at("sidebar_visible", "revision")
    assert_equal [true, 2], response.parsed_body.dig("modules", "ai_assistant").values_at("sidebar_visible", "revision")
    assert_equal [false, 2], response.parsed_body.dig("modules", "import").values_at("sidebar_visible", "revision")
  end

  test "idempotent replay is scoped to the account and does not overwrite later changes" do
    first = request_body(change("budgets", true))
    original = send_update(first)
    assert_response :ok
    assert_equal 1, original["server_revision"]
    send_update(request_body(change("budgets", false, 1), version: 1, device: DEVICE_B))
    assert_response :ok
    assert_no_difference -> { Finance::ModulePreferenceMutation.count } do
      assert_equal original, send_update(first)
    end
    assert_equal 2, @user.finance_module_preferences.sole.revision
    assert_equal false, @user.finance_module_preferences.sole.sidebar_visible
    send_update(first.merge(changes: [change("budgets", false)]))
    assert_response :conflict
    assert_equal "mutation_reused", response.parsed_body["error"]
    send_update(first.merge(account_id: @user.finance_owner_uid), headers: headers_for(@other))
    assert_response :ok
    assert_equal true, @other.finance_module_preferences.sole.sidebar_visible
    assert_equal false, @user.finance_module_preferences.sole.sidebar_visible
  end

  test "partial conflicts preserve both different module edits and latest revision ordering" do
    send_update(request_body(change("reports", true)))
    reply = send_update(request_body(change("reports", false), change("budgets", true), device: DEVICE_B))
    assert_response :ok
    assert_equal ["budgets"], reply["applied"]
    assert_equal 2, reply["server_revision"]
    assert_equal false, reply.dig("conflicts", 0, "proposed_sidebar_visible")
    assert_equal false, reply.dig("conflicts", 0, "proposed_enabled")
    assert_equal true, reply.dig("conflicts", 0, "current", "sidebar_visible")
    assert_equal DEVICE_A, reply.dig("modules", "reports", "updated_by_device_id")
    assert_equal DEVICE_B, reply.dig("modules", "budgets", "updated_by_device_id")
    resolved = send_update(request_body(change("reports", false, 1), device: DEVICE_B, version: 2))
    assert_equal 3, resolved["server_revision"]
    assert_equal false, resolved.dig("modules", "reports", "sidebar_visible")
  end

  test "older apps that send `enabled` still sync; the same mutation replays under either name" do
    id = SecureRandom.uuid
    legacy = send_update(request_body(legacy_change("budgets", true), id: id))
    assert_response :ok
    assert_equal ["budgets"], legacy["applied"]
    assert_equal true, @user.finance_module_preferences.sole.sidebar_visible
    assert_equal legacy, send_update(request_body(change("budgets", true), id: id)), "same choice, same digest"
    send_update(request_body({module_key: "budgets", sidebar_visible: false, enabled: true, expected_revision: 1}, version: 1))
    assert_response :unprocessable_entity, "the two names disagreeing is refused"
    send_update(request_body({module_key: "budgets", expected_revision: 1}, version: 1))
    assert_response :unprocessable_entity
  end

  test "bad payload and modules unavailable on the app write nothing" do
    ["unknown", "settings", "goals", "forecast"].each do |key|
      assert_no_difference -> { Finance::ModulePreference.count + Finance::ModulePreferenceMutation.count } do
        send_update(request_body(change("reports", true), change(key, true)))
      end
      assert_response :unprocessable_entity
    end
    [
      request_body(change("budgets", "true")),
      request_body(change("budgets", true, -1)),
      request_body(change("budgets", true), change("budgets", false)),
      request_body(change("budgets", true), id: "not-a-uuid"),
      request_body(*Array.new(21) { change("budgets", true) }),
      request_body
    ].each do |body|
      send_update(body)
      assert_response :unprocessable_entity
    end
    assert_empty @user.finance_module_preferences
  end

  test "web reads native preferences and rejects an older rendered revision" do
    sign_in @user
    get finance_feature_library_path
    assert_select "#module-budgets input[name=expected_revision][value='0']"
    send_update(request_body(change("budgets", true)))
    patch finance_feature_library_module_path("budgets"), params: {sidebar_visible: "0", expected_revision: 0}, as: :json
    assert_response :conflict
    assert_equal true, response.parsed_body["sidebar_visible"]
    assert_equal 1, response.parsed_body["revision"]
    patch finance_feature_library_module_path("budgets"), params: {sidebar_visible: "0", expected_revision: 1}, as: :json
    assert_response :ok
    get PATH, headers: @auth
    assert_equal false, response.parsed_body.dig("modules", "budgets", "sidebar_visible")
    assert_nil response.parsed_body.dig("modules", "budgets", "updated_by_device_id")
  end

  test "a visibility change leaves representative financial records in place" do
    Finance::Profile.find_or_create_by!(user_id: @user.id) { |profile| profile.currency = "USD" }
    account = Finance::BankAccount.create!(user: @user, manual: true, name: "Synthetic wallet", account_type: "cash", currency: "USD")
    tx = Finance::Ledger.new(@user).create(account_id: account.id, booked_on: Date.current, description: "Synthetic", amount: "-12.34", kind: "expense")
    records = [Finance::Transaction.find(tx.id).attributes, Finance::Statement.where(user: @user).count]
    reply = send_update(request_body(change("transactions", false)))
    assert_equal ["transactions"], reply["applied"]
    assert_equal records, [Finance::Transaction.find(tx.id).attributes, Finance::Statement.where(user: @user).count]
  end
end
