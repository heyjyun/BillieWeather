require "test_helper"

# Reproduces the 13 legacy records the heyjyun account had (ids shortened in comments), and
# checks that consolidation keeps one card, never merges real data and is idempotent.
class Finance::LocalDatabaseConsolidationTest < ActiveSupport::TestCase
  OLD_MAC = "d30ddb65-2073-4d9a-8278-4890c8721cc3"     # first app WebView storage
  PREVIEW = "0c681977-f5f1-4928-b75a-3e6c3e96564d"     # browser preview (in-memory sql.js)
  CURRENT = "754309e7-4ba6-4336-9347-5eb71ddbd657"     # current app WebView storage
  QA = "76cb29fd-45f3-4486-8c6a-6623eb50ec61"          # QA build (com.billieweather.qa)
  REAL_DB = "2dbd7364-bf30-4a2d-aa16-d9603bc9e5a2"     # report_id inside billieweather.db
  QA_DB = "55e25646-f82e-4f9d-8f59-69a5800b969b"

  setup do
    @jyun = create(:onboarded_user, email: "heyjyun-legacy@example.com", usage_region: "US")
    @example = create(:onboarded_user, email: "example-legacy@example.com", usage_region: "US")
    [[OLD_MAC, "Jyun’s MacBook Air"], [PREVIEW, "Mac"], [CURRENT, "Jyun’s MacBook Air"], [QA, "Jyun’s MacBook Air"]].each do |device_id, name|
      Finance::LocalDevice.create!(user: @jyun, device_id: device_id, name: name)
    end
    real = {name: "MacBook Air", size_bytes: 856_064, statement_count: 72, transaction_count: 2687, rule_count: 0,
            period_start: Date.new(2024, 10, 1), period_end: Date.new(2026, 9, 30), modified_at: Time.utc(2026, 11, 9, 6, 35, 29)}
    legacy(OLD_MAC, REAL_DB, reported_at: Time.utc(2026, 11, 9, 20, 25), **real)
    legacy(CURRENT, REAL_DB, reported_at: Time.utc(2026, 11, 12, 5, 31), **real)
    5.times { |i| legacy(PREVIEW, SecureRandom.uuid, size_bytes: 53_248, reported_at: Time.utc(2026, 11, 9, 18, 9 + i)) }
    5.times { |i| legacy(PREVIEW, SecureRandom.uuid, size_bytes: 73_728, reported_at: Time.utc(2026, 11, 9, 19, i)) }
    legacy(QA, QA_DB, size_bytes: 118_784, reported_at: Time.utc(2026, 11, 11, 20, 13))

    # The cloud (web) data and the other account must not be touched.
    statement = Finance::Statement.create!(user: @jyun, filename: "web.csv", currency: "USD", sha256: "b" * 64, transaction_count: 1)
    Finance::Transaction.create!(user: @jyun, statement: statement, booked_on: Date.new(2026, 3, 1), description: "Payroll", amount: "100.00", category: "Income")
    Finance::MerchantRule.create!(user: @jyun, merchant_key: "payroll", income: true, category: "Income")
    Finance::LocalDevice.create!(user: @example, device_id: PREVIEW, name: "Mac")
    legacy(PREVIEW, SecureRandom.uuid, user: @example, name: "Example", size_bytes: 1, statement_count: 2, transaction_count: 3, reported_at: Time.utc(2026, 11, 10))
  end

  def legacy(device_id, database_id, user: @jyun, name: "Unnamed database", statement_count: 0, transaction_count: 0, rule_count: 0, **attributes)
    Finance::LocalDatabaseReport.create!(user: user, device_id: device_id, database_id: database_id, name: name, statement_count: statement_count,
      transaction_count: transaction_count, rule_count: rule_count, sequence: 1, **attributes)
  end

  def jyun_rows = Finance::LocalDatabaseReport.where(user_id: @jyun.id)
  def financial_state = [Finance::Statement.order(:id).pluck(:id, :updated_at), Finance::Transaction.order(:id).pluck(:id, :updated_at, :amount), Finance::MerchantRule.order(:id).pluck(:id, :updated_at)]

  test "the dry run classifies all 13 records and changes nothing" do
    before = jyun_rows.order(:id).pluck(:id, :status, :updated_at)
    plan = Finance::LocalDatabaseConsolidation.new(users: User.where(id: @jyun.id)).plan
    assert_equal 13, plan.size
    assert_equal({keep: 1, archive: 11, review: 1}, plan.map(&:decision).tally.transform_keys(&:to_sym).slice(:keep, :archive, :review))
    assert_equal({"newest_snapshot" => 1, "duplicate_snapshot" => 1, "ephemeral_preview" => 10, "unverified_empty" => 1}, plan.map { |a| a.reason.to_s }.tally)
    kept = plan.find { |a| a.decision == :keep }
    assert_equal [CURRENT, REAL_DB], [kept.device_id, kept.database_id], "the most recent verified snapshot is kept"
    assert_equal before, jyun_rows.order(:id).pluck(:id, :status, :updated_at)
    assert_match(/keep 1, archive 11, review 1/, Finance::LocalDatabaseConsolidation.describe(plan))
  end

  test "applying leaves one active card with 72 statements and 2,687 transactions, archives instead of deleting, and is idempotent" do
    before = financial_state
    applied = Finance::LocalDatabaseConsolidation.new(users: User.where(id: @jyun.id)).apply!
    assert_equal 12, applied.size

    assert_equal 13, jyun_rows.count, "nothing is deleted"
    card = jyun_rows.active.sole
    assert_equal [CURRENT, REAL_DB, 72, 2687], [card.device_id, card.database_id, card.statement_count, card.transaction_count]
    assert_equal ["review"], jyun_rows.in_review.pluck(:status)
    assert_equal QA_DB, jyun_rows.in_review.sole.database_id, "the uncertain QA record is kept for review"
    assert_equal 11, jyun_rows.archived.count
    old = jyun_rows.find_by!(device_id: OLD_MAC)
    assert_equal ["archived", "duplicate_snapshot", Time.utc(2026, 11, 9, 20, 25)], [old.status, old.status_reason, old.reported_at], "the historical timestamp stays"
    assert_equal 12, Finance::LocalDatabaseAudit.where(user_id: @jyun.id).count
    assert_equal 2687, Finance::LocalDatabaseAudit.find_by!(user_id: @jyun.id, device_id: OLD_MAC).details.dig("snapshot", "transaction_count")

    assert_equal before, financial_state, "statements, transactions and rules are never modified"
    assert_equal 1, Finance::LocalDatabaseReport.where(user_id: @example.id).active.count, "another account is untouched"

    assert_empty Finance::LocalDatabaseConsolidation.new(users: User.where(id: @jyun.id)).apply!, "a second run changes nothing"
    assert_equal 12, Finance::LocalDatabaseAudit.where(user_id: @jyun.id).count
  end

  test "different non-empty snapshots of one database id are sent to review, never merged" do
    jyun_rows.find_by!(device_id: OLD_MAC).update!(transaction_count: 2600)
    plan = Finance::LocalDatabaseConsolidation.new(users: User.where(id: @jyun.id)).plan
    diverged = plan.find { |a| a.device_id == OLD_MAC }
    assert_equal [:review, :diverged_copy], [diverged.decision, diverged.reason]
    Finance::LocalDatabaseConsolidation.new(users: User.where(id: @jyun.id)).apply!(plan)
    assert_equal [2600, 2687], jyun_rows.where(database_id: REAL_DB).order(:transaction_count).pluck(:transaction_count)
  end

  test "verified devices are never touched" do
    Finance::LocalDevice.where(user_id: @jyun.id, device_id: QA).update_all(platform: "macos")
    plan = Finance::LocalDatabaseConsolidation.new(users: User.where(id: @jyun.id)).plan
    assert_not plan.any? { |a| a.device_id == QA }
  end

  test "after consolidation the app's next report updates the kept card" do
    Finance::LocalDatabaseConsolidation.new(users: User.where(id: @jyun.id)).apply!
    Finance::LocalDatabaseReport.apply!(user: @jyun, device_id: CURRENT, database_id: REAL_DB, sequence: 2,
      attributes: {name: "MacBook Air", device_name: "Jyun’s MacBook Air", platform: "macos", size_bytes: 856_064, statement_count: 72, transaction_count: 2687, rule_count: 0})
    assert_equal [CURRENT], jyun_rows.active.pluck(:device_id)
    assert Finance::LocalDevice.find_by!(user_id: @jyun.id, device_id: CURRENT).verified?
  end

  test "if the app comes back under the archived device id, it still ends with exactly one card" do
    Finance::LocalDatabaseConsolidation.new(users: User.where(id: @jyun.id)).apply!
    Finance::LocalDatabaseReport.apply!(user: @jyun, device_id: OLD_MAC, database_id: REAL_DB, sequence: 2,
      attributes: {name: "MacBook Air", device_name: "Jyun’s MacBook Air", platform: "macos", size_bytes: 856_064, statement_count: 72, transaction_count: 2687, rule_count: 0})
    assert_equal [OLD_MAC], jyun_rows.active.pluck(:device_id)
  end
end
