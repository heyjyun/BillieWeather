require "test_helper"

# One-way metadata from the apps about their local databases: allowlisted, owner-scoped,
# idempotent and safe against retries and out-of-order arrival. Never financial content.
class ClientApiLocalDatabasesTest < ActionDispatch::IntegrationTest
  PASSWORD = "a-long-test-password-1"
  DEVICE = "3f2b1c9e-7a4d-4e8b-9c11-0a1b2c3d4e5f"
  OTHER_DEVICE = "9d8c7b6a-5e4f-4a3b-8c2d-1e0f9a8b7c6d"
  DATABASE = "11111111-2222-4333-8444-555555555555"
  SECOND = "66666666-7777-4888-8999-aaaaaaaaaaaa"

  setup do
    @user = create(:onboarded_user, email: "meta@example.com", password: PASSWORD, password_confirmation: PASSWORD, usage_region: "US")
    @other = create(:onboarded_user, email: "meta-other@example.com", password: PASSWORD, password_confirmation: PASSWORD, usage_region: "US")
    @auth = sign_in_client(@user)
    @other_auth = sign_in_client(@other)
  end

  def sign_in_client(user)
    post "/api/client/v1/session", params: {email: user.email, password: PASSWORD}, as: :json
    {"Authorization" => "Bearer #{response.parsed_body["token"]}"}
  end

  def payload(overrides = {})
    {name: "Personal Finance 2026", device_name: "Jyun's MacBook", size_bytes: 19_293_798, statement_count: 24, transaction_count: 1240,
     rule_count: 36, period_start: "2026-01-02", period_end: "2026-10-30", modified_at: "2026-11-09T14:00:00Z",
     opened_at: "2026-11-09T14:25:00Z", sequence: 1}.merge(overrides)
  end

  # Keyword arguments other than device/database/headers are report fields.
  def put_report(attrs = {}, device: DEVICE, database: DATABASE, headers: @auth, **fields)
    put "/api/client/v1/devices/#{device}/databases/#{database}", params: {database: payload(attrs.merge(fields))}, headers: headers, as: :json
  end

  def delete_report(sequence, device: DEVICE, database: DATABASE, headers: @auth)
    delete "/api/client/v1/devices/#{device}/databases/#{database}", params: {sequence: sequence}, headers: headers, as: :json
  end

  def reports(user = @user) = Finance::LocalDatabaseReport.where(user_id: user.id)

  test "stores only the allowlisted metadata and stamps the server's own receive time" do
    freeze_time do
      put_report
      assert_response :success
      assert_equal "applied", response.parsed_body["status"]
      report = reports.sole
      assert_equal [DEVICE, DATABASE, "Personal Finance 2026", 19_293_798, 24, 1240, 36], [report.device_id, report.database_id, report.name, report.size_bytes, report.statement_count, report.transaction_count, report.rule_count]
      assert_equal [Date.new(2026, 1, 2), Date.new(2026, 10, 30)], [report.period_start, report.period_end]
      assert_equal Time.current, report.reported_at, "the server records when it received the report"
      assert_equal "Jyun's MacBook", Finance::LocalDevice.find_by!(user_id: @user.id, device_id: DEVICE).name
    end
    columns = Finance::LocalDatabaseReport.column_names - %w[id user_id created_at updated_at]
    assert_equal %w[database_id deleted_at device_id modified_at name opened_at period_end period_start reported_at rule_count sequence size_bytes statement_count transaction_count].sort, columns.sort,
      "the table has no place to put financial content"
  end

  test "rejects any field that is not on the allowlist, and stores nothing" do
    %w[filename description amount balance merchant category path bank_account statements transactions file user_id].each do |field|
      put_report({field => "x"})
      assert_response :unprocessable_entity, field
      assert_equal "unexpected_fields", response.parsed_body["error"]
    end
    assert_equal 0, reports.count
  end

  test "rejects malformed values" do
    [{size_bytes: -1}, {size_bytes: "12"}, {statement_count: 1.5}, {name: ""}, {name: "x" * 61}, {device_name: "y" * 81},
      {period_start: "2026-13-45"}, {modified_at: "yesterday"}, {opened_at: 3.days.from_now.iso8601}, {sequence: 0}, {sequence: "abc"}].each do |bad|
      put_report(bad)
      assert_response :unprocessable_entity, bad.inspect
    end
    put "/api/client/v1/devices/not-a-uuid/databases/#{DATABASE}", params: {database: payload}, headers: @auth, as: :json
    assert_response :unprocessable_entity
    put "/api/client/v1/devices/#{DEVICE}/databases/../../etc", params: {database: payload}, headers: @auth, as: :json
    assert_includes [404, 422], response.status
    assert_equal 0, reports.count
  end

  test "names are cleaned of control characters and stored as plain text" do
    put_report(name: "  <b>Work</b>\u0007   books ", device_name: "Jyun\u0000's\n  Mac")
    assert_equal "<b>Work</b> books", reports.sole.name
    assert_equal "Jyun's Mac", Finance::LocalDevice.find_by!(user_id: @user.id, device_id: DEVICE).name
  end

  test "requires authentication on every operation" do
    put_report({}, headers: {})
    assert_response :unauthorized
    delete_report(2, headers: {})
    assert_response :unauthorized
    delete "/api/client/v1/devices/#{DEVICE}", params: {sequence: 1}, as: :json
    assert_response :unauthorized
    assert_equal 0, Finance::LocalDatabaseReport.count
  end

  test "the same report twice is one record, a rename keeps the id, and the server never trusts a user id" do
    put_report
    put_report
    assert_equal 1, reports.count
    assert_equal "ignored", response.parsed_body["status"], "an exact repeat changes nothing"
    put_report(name: "Renamed", sequence: 2)
    assert_equal "applied", response.parsed_body["status"]
    assert_equal ["Renamed"], reports.pluck(:name)
    assert_equal [DATABASE], reports.pluck(:database_id)

    put "/api/client/v1/devices/#{DEVICE}/databases/#{DATABASE}", params: {database: payload(sequence: 3).merge(user_id: @other.id)}, headers: @auth, as: :json
    assert_response :unprocessable_entity
  end

  test "an older report arriving late is ignored" do
    put_report(statement_count: 10, sequence: 5)
    put_report(statement_count: 99, sequence: 4)
    assert_equal "ignored", response.parsed_body["status"]
    assert_equal 10, reports.sole.statement_count
  end

  test "a deleted database stays deleted even if an older report arrives afterwards" do
    put_report(sequence: 1)
    delete_report(3)
    assert_equal "applied", response.parsed_body["status"]
    assert_equal 0, reports.live.count
    tombstone = reports.sole
    assert_nil tombstone.name
    assert_nil tombstone.size_bytes
    put_report(sequence: 2)
    assert_equal "ignored", response.parsed_body["status"]
    assert_equal 0, reports.live.count
    delete_report(3)
    assert_response :success, "deleting twice is fine"
    put_report(sequence: 4, name: "Brought back")
    assert_equal ["Brought back"], reports.live.pluck(:name), "a newer report from the device is accepted"
  end

  test "deleting something never reported is harmless" do
    delete_report(1)
    assert_response :success
    assert_equal 0, reports.live.count
  end

  test "one person cannot see, change or delete another person's reports" do
    put_report(headers: @auth)
    put_report({name: "Mine too", sequence: 1}, headers: @other_auth)
    assert_equal 1, reports(@user).live.count
    assert_equal 1, reports(@other).live.count
    delete_report(9, headers: @other_auth)
    assert_equal ["Personal Finance 2026"], reports(@user).live.pluck(:name)
    assert_equal 0, reports(@other).live.count
    delete "/api/client/v1/devices/#{DEVICE}", params: {sequence: 20}, headers: @other_auth, as: :json
    assert_equal 1, reports(@user).live.count
  end

  test "purging a device removes all its reports, keeps other devices, and refuses older reports" do
    put_report(sequence: 1)
    put_report({sequence: 2}, database: SECOND)
    put_report({sequence: 3}, device: OTHER_DEVICE)
    delete "/api/client/v1/devices/#{DEVICE}", params: {sequence: 10}, headers: @auth, as: :json
    assert_response :success
    assert_equal "applied", response.parsed_body["status"]
    assert_equal [OTHER_DEVICE], reports.pluck(:device_id)
    assert_nil Finance::LocalDevice.find_by!(user_id: @user.id, device_id: DEVICE).name

    put_report(sequence: 9)
    assert_equal "ignored", response.parsed_body["status"]
    assert_equal [OTHER_DEVICE], reports.pluck(:device_id)
    put_report(sequence: 11)
    assert_equal "applied", response.parsed_body["status"], "reporting can be turned on again later"
  end

  test "there is no way for the server to command a device" do
    %w[get post patch].each do |verb|
      assert_raises(ActionController::RoutingError) { Rails.application.routes.recognize_path("/api/client/v1/devices/#{DEVICE}/databases/#{DATABASE}", method: verb) }
    end
    assert_raises(ActionController::RoutingError) { Rails.application.routes.recognize_path("/api/client/v1/devices/#{DEVICE}", method: :put) }
  end

  test "reporting does not touch the cloud database" do
    Finance::Profile.create!(user: @user, currency: "USD")
    before = [Finance::Statement.count, Finance::Transaction.count, Finance::Profile.count]
    get "/api/client/v1/finance", headers: @auth, as: :json
    cloud_bytes = response.parsed_body["storage_bytes"]
    put_report(size_bytes: 500_000_000)
    delete_report(2)
    put_report(size_bytes: 500_000_000, sequence: 3)
    assert_equal before, [Finance::Statement.count, Finance::Transaction.count, Finance::Profile.count]
    get "/api/client/v1/finance", headers: @auth, as: :json
    assert_response :success
    assert_equal cloud_bytes, response.parsed_body["storage_bytes"], "reported local sizes never count as cloud storage"
  end

  test "deleting the account removes its reports" do
    put_report
    @user.destroy!
    assert_equal 0, Finance::LocalDatabaseReport.where(database_id: DATABASE).count
    assert_equal 0, Finance::LocalDevice.where(device_id: DEVICE).count
  end
end
