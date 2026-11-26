# Synthetic benchmark of the finance_transactions hot paths. Everything runs inside one database
# transaction that is rolled back, so the disposable test database is left exactly as it was.
module Bench
  def self.realtime
    started = Process.clock_gettime(Process::CLOCK_MONOTONIC)
    yield
    Process.clock_gettime(Process::CLOCK_MONOTONIC) - started
  end
end
abort "refusing: not the disposable test database" unless ActiveRecord::Base.connection.current_database == "billieweather_codex_audit_test" && Rails.env.test?
conn = ActiveRecord::Base.connection
out = {}
ActiveRecord::Base.transaction do
  users = 2.times.map { |n| User.create!(email: "bench-#{SecureRandom.hex(6)}@example.com", password: "08h4f78hrc0ohw9f8heso", password_confirmation: "08h4f78hrc0ohw9f8heso", usage_region: "US", time_zone: "UTC") }
  now = Time.current
  has_status = Finance::Statement.column_names.include?("status")
  ids = {}
  users.each_with_index do |user, index|
    account = Finance::BankAccount.create!(user: user, manual: true, name: "Bench #{index}", account_type: "checking")
    merchant = Finance::Merchant.create!(user: user, name: "Synthetic Merchant #{index}")
    statement = Finance::Statement.create!({user: user, filename: "bench.csv", currency: "USD", sha256: SecureRandom.hex(32), transaction_count: 1, bank_account: account}.merge(has_status ? {status: "imported"} : {}))
    count = (index == 0) ? 60_000 : 20_000
    rows = count.times.map do |n|
      {user_id: user.id, statement_id: statement.id, bank_account_id: account.id, booked_on: Date.new(2024, 1, 1) + (n % 900), description: "SYNTHETIC ROW #{n}",
       original_description: "SYNTHETIC ROW #{n}", amount: BigDecimal((n % 2 == 0) ? "-12.34" : "56.78"), category: "Shopping", kind: (n % 2 == 0) ? "expense" : "income",
       entry_origin: "import", category_source: "auto", merchant_id: (n % 400 == 0) ? merchant.id : nil, deleted_at: (n % 500 == 1) ? now : nil, created_at: now, updated_at: now}
    end
    elapsed = Bench.realtime { rows.each_slice(500) { |batch| Finance::Transaction.insert_all!(batch) } }
    out["insert_#{count}_rows_ms"] = (elapsed * 1000).round
    ids[index] = {user: user, merchant: merchant}
  end
  conn.execute("ANALYZE finance_transactions")
  user = ids[0][:user]
  merchant = ids[0][:merchant]
  list = Finance::Transaction.live.where(user_id: user.id).recent_first.limit(50)
  trash = Finance::Transaction.trashed.where(user_id: user.id).order(deleted_at: :desc).limit(50)
  by_merchant = Finance::Transaction.where(user_id: user.id, merchant_id: merchant.id)
  month = Finance::Transaction.included.where(user_id: user.id, booked_on: Date.new(2025, 3, 1)..Date.new(2025, 3, 31)).group(:kind)
  # Server-side execution time (EXPLAIN ANALYZE), median of 31 runs: independent of Ruby object building.
  timed = ->(relation) do
    sql = relation.respond_to?(:to_sql) ? relation.to_sql : relation
    31.times.map { JSON.parse(conn.select_value("EXPLAIN (ANALYZE, FORMAT JSON) #{sql}"))[0]["Execution Time"] }.sort[15].round(3)
  end
  out["list_newest_50_ms"] = timed.call(list)
  out["trash_50_ms"] = timed.call(trash)
  out["entries_of_merchant_ms"] = timed.call(by_merchant)
  out["month_totals_ms"] = timed.call(month.select("kind, SUM(amount)"))
  # What deleting a merchant makes the database do for its ON DELETE SET NULL: find the entries by merchant_id alone.
  out["merchant_reference_lookup_ms"] = timed.call("SELECT 1 FROM finance_transactions WHERE merchant_id = #{merchant.id}")
  out["plan_merchant_reference_lookup"] = conn.select_values("EXPLAIN SELECT 1 FROM finance_transactions WHERE merchant_id = #{merchant.id}").grep(/Scan/).map { |line| line.strip.sub(/\s+\(cost.*/, "") }.join(" | ")
  plan = ->(relation) { conn.select_values("EXPLAIN #{relation.to_sql}").grep(/Scan/).map { |line| line.strip.sub(/\s+\(cost.*/, "") }.join(" | ") }
  out["plan_list"] = plan.call(list)
  out["plan_merchant"] = plan.call(by_merchant)
  out["plan_trash"] = plan.call(trash)
  out["indexes_on_transactions"] = conn.select_value("SELECT count(*) FROM pg_indexes WHERE tablename = 'finance_transactions'")
  out["index_bytes_transactions"] = conn.select_value("SELECT pg_indexes_size('finance_transactions')")
  out["table_bytes_transactions"] = conn.select_value("SELECT pg_relation_size('finance_transactions')")
  raise ActiveRecord::Rollback
end
puts JSON.pretty_generate(out)
