require "test_helper"

class Finance::ImportPerformanceTest < ActiveSupport::TestCase
  setup do
    @user = create(:onboarded_user, usage_region: "US")
    @profile = Finance::Profile.create!(user: @user, currency: "USD")
    @account = Finance::BankAccount.create!(user: @user, manual: true, name: "Synthetic checking", account_type: "checking")
  end

  test "date and account filtering preserves every duplicate verdict with a large synthetic history" do
    other = Finance::BankAccount.create!(user: @user, manual: true, name: "Other checking", account_type: "checking")
    statement = Finance::Statement.create!(user: @user, filename: "synthetic.csv", currency: "USD", sha256: "9" * 64, transaction_count: 20_150)
    base = {user_id: @user.id, statement_id: statement.id, kind: "expense", category: "Shopping", entry_origin: "import", created_at: Time.current, updated_at: Time.current}
    rows = 20_000.times.map do |index|
      base.merge(bank_account_id: @account.id, booked_on: Date.new(2020, 1, 1) + index % 365, amount: -1,
        description: "Synthetic old #{index}", original_description: "Synthetic old #{index}")
    end
    incoming = 150.times.map do |index|
      {account: @account.id, date: Date.new(2026, 11, 1), amount: -BigDecimal(index + 1) / 100, description: "Synthetic purchase #{index}"}
    end
    incoming.each_with_index do |row, index|
      account_id = if index < 50
        @account.id
      elsif index < 100
        nil
      else
        other.id
      end
      rows << base.merge(bank_account_id: account_id,
        booked_on: row[:date], amount: row[:amount], description: row[:description], original_description: row[:description])
    end
    rows.each_slice(500) { |batch| Finance::Transaction.insert_all!(batch) }
    started = Process.clock_gettime(Process::CLOCK_MONOTONIC)
    full = Finance::DuplicateDetector.stored_rows(@user)
    full_seconds = Process.clock_gettime(Process::CLOCK_MONOTONIC) - started
    started = Process.clock_gettime(Process::CLOCK_MONOTONIC)
    filtered = Finance::DuplicateDetector.stored_rows(@user, dates: Date.new(2026, 11, 1)..Date.new(2026, 11, 30), account_id: @account.id)
    filtered_seconds = Process.clock_gettime(Process::CLOCK_MONOTONIC) - started
    assert_equal 20_150, full.length
    assert_equal 100, filtered.length
    assert_equal Finance::DuplicateDetector.call(full, incoming), Finance::DuplicateDetector.call(filtered, incoming)
    plan = Finance::ImportPlan.new(user: @user, bank_account: @account,
      rows: incoming.map { |row| {booked_on: row[:date], amount: row[:amount], description: row[:description], category: "Shopping"} })
    assert_equal 50, plan.skipped
    assert_equal 50, plan.flagged.length
    puts "DEDUPE_BENCH rows=#{full.length}->#{filtered.length} fetch_ms=#{(full_seconds * 1000).round(2)}->#{(filtered_seconds * 1000).round(2)} verdicts=identical"
  end

  test "manual transaction exports reuse the supplied profile instead of querying once per row" do
    25.times do |index|
      Finance::Transaction.create!(user: @user, bank_account: @account, entry_origin: "manual", kind: "expense", amount: -1,
        booked_on: Date.new(2026, 11, 1), category: "Shopping", description: "Synthetic manual #{index}")
    end
    report = Finance::Report.new(user: @user, profile: @profile, period: Finance::DashboardPeriod.new, balance_summary: {})
    queries = []
    capture = ->(_name, _start, _finish, _id, payload) { queries << payload[:sql] if payload[:sql].include?('FROM "finance_profiles"') }
    exported = ActiveSupport::Notifications.subscribed(capture, "sql.active_record") { report.each_transaction_row.to_a }
    assert_equal 25, exported.length
    assert exported.all? { |row| row.currency == "USD" }
    assert_empty queries, "the profile is already supplied to Report"
  end
  test "custom income classification reads category settings once for a large import" do
    Finance::CustomCategory.create!(user: @user, name: "Synthetic Salary")
    Finance::CategorySetting.create!(user: @user, name: "Synthetic Salary", category_kind: "income")
    rows = 400.times.map { |index| {booked_on: Date.new(2026, 11, 1), amount: BigDecimal(index + 1), description: "Synthetic employer #{index}", category: "Synthetic Salary"} }
    queries = []
    capture = ->(_name, _start, _finish, _id, payload) { queries << payload[:sql] if payload[:sql].include?('FROM "finance_category_settings"') }
    plan = ActiveSupport::Notifications.subscribed(capture, "sql.active_record") { Finance::ImportPlan.new(user: @user, rows: rows, bank_account: @account) }
    assert_equal 400, plan.rows.length
    assert plan.rows.all? { |row| row[:kind] == "income" }
    assert_equal 1, queries.length
  end
end
