require "test_helper"

# Settings › Local databases › Manage: a person removes local database RECORDS from the
# website, one at a time or several at once. Only metadata goes away; nothing reaches a
# device, and a newer report from the app brings a still-existing database back.
class LocalDatabaseRemovalTest < ActionDispatch::IntegrationTest
  include Devise::Test::IntegrationHelpers

  PASSWORD = "a-long-test-password-1"
  MAC = "3f2b1c9e-7a4d-4e8b-9c11-0a1b2c3d4e5f"
  MAIN_DB = "2dbd7364-bf30-4a2d-aa16-d9603bc9e5a2"
  EMPTY_DB = "55e25646-f82e-4f9d-8f59-69a5800b969b"
  SPARE_DB = "6a1f0c2e-3b4d-4e5f-8a9b-0c1d2e3f4a5b"

  setup do
    @user = create(:onboarded_user, password: PASSWORD, password_confirmation: PASSWORD, usage_region: "US")
    @other = create(:onboarded_user, password: PASSWORD, password_confirmation: PASSWORD, usage_region: "US")
    @sequence = 0
  end

  def report(database, user: @user, **fields)
    @sequence += 1
    attributes = {name: "MacBook Air", device_name: "MacBook Air", platform: "macos", size_bytes: 856_064, statement_count: 72,
                  transaction_count: 2687, rule_count: 0, period_start: Date.new(2024, 10, 1), period_end: Date.new(2026, 9, 30),
                  modified_at: 1.day.ago, opened_at: Time.current, synced_at: nil}.merge(fields)
    Finance::LocalDatabaseReport.apply!(user: user, device_id: MAC, database_id: database, sequence: @sequence, attributes: attributes)
    Finance::LocalDatabaseReport.find_by!(user_id: user.id, device_id: MAC, database_id: database)
  end

  def empty_report(database)
    report(database, name: "Unnamed database", size_bytes: 53_248, statement_count: 0, transaction_count: 0, period_start: nil, period_end: nil)
  end

  test "removing one record tombstones only that record and leaves an audit entry" do
    main = report(MAIN_DB)
    empty = empty_report(EMPTY_DB)
    sign_in @user

    delete finance_remove_local_database_reports_path, params: {ids: [empty.id]}
    assert_redirected_to finance_settings_path(anchor: "settings-local-manage")
    follow_redirect!
    assert_select ".bw-flash", text: /1 record removed/

    assert_not_nil empty.reload.deleted_at
    assert_nil empty.name
    assert_nil main.reload.deleted_at
    audit = Finance::LocalDatabaseAudit.find_by!(user_id: @user.id, event: "removed_by_person")
    assert_equal EMPTY_DB, audit.database_id
    assert_equal "Unnamed database", audit.details["previous_snapshot"]["name"]
  end

  test "removing several records at once, and the device card goes away when nothing is left" do
    ids = [report(MAIN_DB), empty_report(EMPTY_DB), empty_report(SPARE_DB)].map(&:id)
    sign_in @user

    delete finance_remove_local_database_reports_path, params: {ids: ids.map(&:to_s)}
    follow_redirect!
    assert_select ".bw-flash", text: /3 records removed/
    assert_equal 0, Finance::LocalDatabaseReport.live.where(user_id: @user.id).count
    assert_select "[data-local-device]", count: 0
    assert_select "#settings-local-manage", count: 0
  end

  test "another account's records cannot be removed, and junk ids are ignored" do
    theirs = report(MAIN_DB, user: @other)
    sign_in @user

    delete finance_remove_local_database_reports_path, params: {ids: [theirs.id, "abc", "-4", ""]}
    follow_redirect!
    assert_select ".bw-flash-error", text: /already removed/
    assert_nil theirs.reload.deleted_at

    delete finance_remove_local_database_reports_path
    follow_redirect!
    assert_select ".bw-flash-error", text: /Select at least one/
  end

  test "an old retry cannot bring a removed record back, but a newer report from the app does" do
    row = report(MAIN_DB)
    stale_sequence = row.sequence
    Finance::LocalDatabaseReport.remove_by_person!(user: @user, ids: [row.id])

    status = Finance::LocalDatabaseReport.apply!(user: @user, device_id: MAC, database_id: MAIN_DB, sequence: stale_sequence,
      attributes: {name: "MacBook Air", device_name: "MacBook Air", platform: "macos", size_bytes: 1, statement_count: 0, transaction_count: 0, rule_count: 0})
    assert_equal :ignored, status
    assert_not_nil row.reload.deleted_at

    report(MAIN_DB, name: "Reopened")
    assert_nil row.reload.deleted_at
    assert_equal "Reopened", row.name
  end

  test "removing never touches the cloud database" do
    Finance::Profile.find_or_create_by!(user: @user) { |profile| profile.currency = "USD" }
    account = Finance::BankAccount.create!(user: @user, identity_key: "7" * 64, bank_name: "Chase", name: "Checking", last4: "1234", kind: "cash")
    statement = Finance::Statement.create!(user: @user, bank_account: account, filename: "march.csv", currency: "USD", sha256: "7" * 64, transaction_count: 1)
    Finance::Transaction.create!(user: @user, statement: statement, booked_on: Date.new(2026, 3, 1), description: "Payroll", amount: "100.00", category: "Income")
    row = report(MAIN_DB)
    sign_in @user

    assert_no_difference ["Finance::Statement.count", "Finance::Transaction.count", "Finance::BankAccount.count"] do
      delete finance_remove_local_database_reports_path, params: {ids: [row.id]}
    end
    assert_not_nil row.reload.deleted_at
  end

  test "settings lists every record with a checkbox, a single remove button and one confirmation dialog" do
    main = report(MAIN_DB)
    empty = empty_report(EMPTY_DB)
    sign_in @user
    get finance_settings_path, params: {locale: "en"}
    assert_response :success

    assert_select "#settings-local-manage[data-local-manage]" do
      assert_select "form#local-db-remove-form[action='#{finance_remove_local_database_reports_path}'][data-local-remove=bulk]" do
        assert_select "input[name='_method'][value=delete]"
        assert_select "button[data-local-select-empty]", text: "Select empty ones (1)"
      end
      assert_select "input[data-local-pick][form='local-db-remove-form'][name='ids[]']", count: 2
      assert_select "li[data-local-manage-row='#{empty.id}'] .bw-tag", text: "Empty"
      assert_select "li[data-local-manage-row='#{main.id}'] .bw-tag", count: 0
      assert_select "form[data-local-remove=single]", count: 2
      assert_select "form[data-local-remove=single] input[name='ids[]'][value='#{main.id}']"
      assert_select "dialog#local-db-remove-dialog", text: /database file on the device.*not deleted/m
    end
  end
end
