require "test_helper"

# Regression tests for duplicate local database cards: one logical record per
# (account, device, database), updated in place by every report, never duplicated by
# relaunches, renames or concurrency, and never merged across devices or accounts.
class LocalDatabaseIdentityTest < ActionDispatch::IntegrationTest
  PASSWORD = "a-long-test-password-1"
  MAC = "3f2b1c9e-7a4d-4e8b-9c11-0a1b2c3d4e5f"
  PHONE = "9d8c7b6a-5e4f-4a3b-8c2d-1e0f9a8b7c6d"
  MAIN_DB = "2dbd7364-bf30-4a2d-aa16-d9603bc9e5a2"
  OTHER_DB = "55e25646-f82e-4f9d-8f59-69a5800b969b"

  setup do
    @jyun = create(:onboarded_user, email: "heyjyun-test@example.com", password: PASSWORD, password_confirmation: PASSWORD, usage_region: "US")
    @other = create(:onboarded_user, email: "someone-else@example.com", password: PASSWORD, password_confirmation: PASSWORD, usage_region: "US")
    @auth = sign_in_client(@jyun)
    @other_auth = sign_in_client(@other)
    @sequence = 0
  end

  def sign_in_client(user)
    post "/api/client/v1/session", params: {email: user.email, password: PASSWORD}, as: :json
    {"Authorization" => "Bearer #{response.parsed_body["token"]}"}
  end

  def report(device: MAC, database: MAIN_DB, headers: @auth, **fields)
    @sequence += 1
    body = {name: "MacBook Air", device_name: "Jyun’s MacBook Air", platform: "macos", size_bytes: 856_064, statement_count: 72,
            transaction_count: 2687, rule_count: 0, period_start: "2024-10-01", period_end: "2026-09-30",
            modified_at: "2026-11-09T06:35:29Z", opened_at: Time.current.utc.iso8601, synced_at: nil, sequence: @sequence}.merge(fields)
    put "/api/client/v1/devices/#{device}/databases/#{database}", params: {database: body}, headers: headers, as: :json
  end

  def rows(user = @jyun) = Finance::LocalDatabaseReport.where(user_id: user.id)

  test "reopening the same app 20 times keeps exactly one record, updated in place" do
    20.times do |launch|
      travel 1.minute
      report(opened_at: Time.current.utc.iso8601, size_bytes: 856_064 + launch)
      assert_response :success
      assert_equal "applied", response.parsed_body["status"]
    end
    assert_equal 1, rows.count
    assert_equal 1, Finance::LocalDevice.where(user_id: @jyun.id).count
    row = rows.sole
    assert_equal 856_064 + 19, row.size_bytes, "the latest launch's numbers are shown"
    assert_equal "active", row.status
    assert_in_delta Time.current, row.opened_at, 1.second
    assert_in_delta Time.current, row.reported_at, 1.second
  end

  test "a device name change updates the same card instead of creating a new one" do
    report(device_name: "MacBook Air")
    report(device_name: "Jyun’s MacBook Air")
    report(name: "Renamed database")
    assert_equal 1, rows.count
    assert_equal "Jyun’s MacBook Air", Finance::LocalDevice.find_by!(user_id: @jyun.id, device_id: MAC).name
    assert_equal "Renamed database", rows.sole.name
  end

  test "two devices create exactly two device records" do
    report(device: MAC)
    report(device: PHONE, database: OTHER_DB, device_name: "iPhone", platform: "ios")
    report(device: MAC)
    assert_equal 2, Finance::LocalDevice.where(user_id: @jyun.id).count
    assert_equal 2, rows.active.count
    assert_equal %w[ios macos], Finance::LocalDevice.where(user_id: @jyun.id).pluck(:platform).sort
  end

  test "two accounts on one device stay isolated" do
    report(headers: @auth)
    report(headers: @other_auth, name: "Someone else’s", statement_count: 1)
    assert_equal ["MacBook Air"], rows(@jyun).pluck(:name)
    assert_equal ["Someone else’s"], rows(@other).pluck(:name)
    assert_equal 72, rows(@jyun).sole.statement_count, "the other account's report never overwrote this one"
    delete "/api/client/v1/devices/#{MAC}", params: {sequence: 10_000}, headers: @other_auth, as: :json
    assert_equal 1, rows(@jyun).live.count
  end

  test "an incomplete identity (no platform: browser preview or old build) is refused and stores nothing" do
    report(platform: nil)
    assert_response :unprocessable_entity
    assert_equal "incomplete_identity", response.parsed_body["error"]
    report(platform: "browser")
    assert_response :unprocessable_entity
    assert_equal 0, rows.count
    assert_equal 0, Finance::LocalDevice.where(user_id: @jyun.id).count
  end

  test "different non-empty databases on one device are kept apart, with an audit entry" do
    report(database: MAIN_DB)
    report(database: OTHER_DB, name: "Work", statement_count: 3, transaction_count: 40)
    assert_equal 2, rows.active.count
    assert_equal [40, 2687], rows.order(:transaction_count).pluck(:transaction_count)
    audit = Finance::LocalDatabaseAudit.where(user_id: @jyun.id, event: "database_added").sole
    assert_equal OTHER_DB, audit.database_id
    assert_equal [MAIN_DB], audit.details["other_databases_on_device"]
  end

  test "the same database seen from a new device id moves the card and keeps the old association in the audit" do
    report(device: MAC)
    report(device: PHONE, device_name: "Jyun’s MacBook Air")
    assert_equal [PHONE], rows.active.pluck(:device_id)
    old = rows.find_by!(device_id: MAC)
    assert_equal ["archived", "superseded_by_other_device"], [old.status, old.status_reason]
    assert_equal 2687, old.transaction_count, "the previous snapshot is kept, not deleted"
    audit = Finance::LocalDatabaseAudit.where(user_id: @jyun.id, event: "database_superseded").sole
    assert_equal [MAC, PHONE], [audit.device_id, audit.details["to_device_id"]]
    assert_equal 2687, audit.details.dig("previous_snapshot", "transaction_count")
  end

  test "two live devices reporting the same database are never silently combined: both go to review" do
    report(device: MAC)
    report(device: PHONE)
    report(device: MAC, transaction_count: 2700) # the first device is still alive: a copied file
    assert_equal 0, rows.active.count
    assert_equal %w[review review], rows.pluck(:status)
    assert_equal [2687, 2700], rows.order(:transaction_count).pluck(:transaction_count)
    assert Finance::LocalDatabaseAudit.exists?(user_id: @jyun.id, event: "database_on_multiple_devices")
    report(device: PHONE)
    assert_equal 0, rows.active.count, "further reports keep them in review until the person decides"
  end

  test "metadata reports never carry or store financial content" do
    %w[description amount balance merchant filename statements transactions file path].each do |field|
      report(field => "x")
      assert_response :unprocessable_entity
    end
    report
    stored = rows.sole.attributes.values.map(&:to_s).join(" ")
    assert_no_match(/Payroll|Coffee/, stored)
    assert_nil rows.sole.synced_at, "no sync time unless the app reports a real Sync Now"
  end

  test "a reported sync time is the app's explicit Sync Now, nothing else" do
    report(synced_at: "2026-11-10T08:00:00Z")
    assert_equal Time.utc(2026, 11, 10, 8), rows.sole.synced_at
    report(synced_at: nil)
    assert_nil rows.sole.synced_at
  end

  test "reporting leaves the web database untouched" do
    statement = Finance::Statement.create!(user: @jyun, filename: "web.csv", currency: "USD", sha256: "a" * 64, transaction_count: 1)
    Finance::Transaction.create!(user: @jyun, statement: statement, booked_on: Date.new(2026, 3, 1), description: "Payroll", amount: "100.00", category: "Income")
    before = [Finance::Statement.where(user: @jyun).pluck(:id, :updated_at), Finance::Transaction.where(user: @jyun).pluck(:id, :updated_at), Finance::MerchantRule.count]
    3.times { report }
    report(device: PHONE, database: OTHER_DB)
    assert_equal before, [Finance::Statement.where(user: @jyun).pluck(:id, :updated_at), Finance::Transaction.where(user: @jyun).pluck(:id, :updated_at), Finance::MerchantRule.count]
  end
end

# Real concurrency needs real transactions, so this class commits and cleans up after itself.
class LocalDatabaseConcurrentReportTest < ActiveSupport::TestCase
  self.use_transactional_tests = false

  DEVICE = "0c681977-f5f1-4928-b75a-3e6c3e96564d"
  DATABASE = "2dbd7364-bf30-4a2d-aa16-d9603bc9e5a2"
  # One connection stays with the test thread.
  WORKERS = [ActiveRecord::Base.connection_pool.size - 1, 2].max

  setup { @user = create(:onboarded_user, email: "concurrent-#{SecureRandom.hex(4)}@example.com", usage_region: "US") }
  teardown do
    Finance::LocalDatabaseAudit.where(user_id: @user.id).delete_all
    Finance::LocalDatabaseReport.where(user_id: @user.id).delete_all
    Finance::LocalDevice.where(user_id: @user.id).delete_all
    @user.destroy!
  end

  test "concurrent reports for the same device and database never create duplicates" do
    attributes = {name: "MacBook Air", device_name: "Mac", platform: "macos", size_bytes: 1, statement_count: 0, transaction_count: 0, rule_count: 0}
    start = Concurrent::CountDownLatch.new(1)
    threads = WORKERS.times.map do |index|
      Thread.new do
        ActiveRecord::Base.connection_pool.with_connection do
          start.wait
          Finance::LocalDatabaseReport.apply!(user: @user, device_id: DEVICE, database_id: DATABASE, sequence: index + 1, attributes: attributes.merge(size_bytes: index + 1))
        end
      end
    end
    start.count_down
    threads.each(&:join)
    assert_equal 1, Finance::LocalDatabaseReport.where(user_id: @user.id).count
    assert_equal 1, Finance::LocalDevice.where(user_id: @user.id).count
    assert_equal WORKERS, Finance::LocalDatabaseReport.where(user_id: @user.id).sole.sequence, "the highest sequence wins regardless of arrival order"
  end
end
