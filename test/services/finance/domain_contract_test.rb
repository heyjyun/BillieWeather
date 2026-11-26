require "test_helper"

# Contract tests shared with the TypeScript clients (packages/finance-core/test/ledger.test.ts):
# both sides replay the same fixtures and must agree.
class Finance::DomainContractTest < ActiveSupport::TestCase
  FIXTURES = Rails.root.join("packages/finance-core/fixtures")

  def fixture(path) = JSON.parse(File.read(FIXTURES.join(path)))

  test "manifest: liabilities, counted kinds and legacy account vocabularies" do
    assert_equal %w[credit_card loan], Finance::Domain::LIABILITY_TYPES.sort
    assert_equal %w[expense income refund], Finance::Domain::COUNTED_KINDS.sort
    assert_equal "expense", Finance::Domain.counts_as("refund")
    assert_nil Finance::Domain.counts_as("card_payment")
    assert_equal "credit_card", Finance::Domain.account_type_from_legacy("credit")
    assert_equal "checking", Finance::Domain.account_type_from_legacy("cash")
    assert_equal "other", Finance::Domain.account_type_from_legacy("unknown")
    assert_equal Finance::DefaultCategories::LEGACY_NAMES.sort, Finance::Domain::SCHEMA["builtin_categories"].map { |c| c["key"] }.sort
  end

  test "inferKind cases (kind-cases.json)" do
    fixture("kind-cases.json")["cases"].each do |c|
      actual = Finance::Domain.infer_kind(amount: BigDecimal(c["amountMinor"]) / 100, account_type: c["accountType"], description: c["description"])
      assert_equal c["kind"], actual, "#{c["description"]} #{c["amountMinor"]} #{c["accountType"]}"
    end
  end

  test "kindForCategorized cases (kind-cases.json categorized)" do
    fixture("kind-cases.json")["categorized"].each do |c|
      actual = Finance::Domain.kind_for_categorized(amount: BigDecimal(c["amountMinor"]) / 100, account_type: c["accountType"],
        description: c["description"], category: c["category"], income_categories: Array(c["incomeCategories"]))
      assert_equal c["kind"], actual, "#{c["description"]} #{c["category"]}"
    end
  end

  test "legacy backfill reproduces old totals; suspect income is listed, not changed" do
    assert_equal "income", Finance::Domain.legacy_kind(amount: 30, category: "Shopping")
    assert_equal "transfer", Finance::Domain.legacy_kind(amount: 170, category: "Transfers")
    assert_equal "refund", Finance::Domain.suspect_income(kind: "income", amount: 30, account_type: "credit_card", description: "ZXQ OUTFITTERS")
    assert_nil Finance::Domain.suspect_income(kind: "income", amount: 2000, account_type: "checking", description: "ZXQ PAYROLL")
  end

  test "duplicate detection cases (dedupe-cases.json)" do
    fixture("dedupe-cases.json")["cases"].each do |c|
      row = ->(item) { {id: item["id"], account: item["account"], date: item["date"], amount: BigDecimal(item["amountMinor"]) / 100, description: item["description"], reference: item["reference"]} }
      verdicts = Finance::DuplicateDetector.call(c["existing"].map(&row), c["incoming"].map(&row))
      assert_equal c["expected"], verdicts.map(&:result), c["name"]
    end
  end

  test "manual entry validation codes match entryProblems" do
    base = {kind: "expense", amount: "1.00", occurred_on: "2026-10-01", account_id: 1, category_kind: "expense"}
    assert_equal [], Finance::Domain.entry_problems(**base)
    assert_equal ["amount_zero"], Finance::Domain.entry_problems(**base, amount: "0")
    assert_equal ["amount_required"], Finance::Domain.entry_problems(**base, amount: "")
    assert_equal ["amount_precision"], Finance::Domain.entry_problems(**base, amount: "0.125")
    assert_equal ["date_invalid"], Finance::Domain.entry_problems(**base, occurred_on: "2026-13-40")
    assert_equal ["account_required"], Finance::Domain.entry_problems(**base, account_id: nil)
    assert_equal ["category_kind"], Finance::Domain.entry_problems(**base, category_kind: "income")
    assert_equal ["accounts_same"], Finance::Domain.entry_problems(**base, kind: "transfer", to_account_id: 1, category_kind: nil)
    assert_equal ["refund_too_large"], Finance::Domain.entry_problems(**base, kind: "refund", amount: "60", refund_of: {amount: BigDecimal("-80"), refunded: BigDecimal(30)})
    assert_equal ["refund_target_required"], Finance::Domain.entry_problems(**base, kind: "refund", refund_of: nil)
    assert_equal [], Finance::Domain.entry_problems(**base, kind: "adjustment", amount: "0", category_kind: nil)
    assert_equal ["kind_invalid"], Finance::Domain.entry_problems(**base, kind: "bogus")
  end

  test "recurrence clamps month ends and budget periods honour the month start" do
    assert_equal %w[2026-01-31 2026-02-28 2026-03-31 2026-04-30 2026-05-31], Finance::Domain.occurrences("2026-01-31", "2026-05-31", "monthly").map(&:iso8601)
    assert_equal Date.new(2026, 10, 22), Finance::Domain.next_occurrence("2026-10-15", "2026-10-15", "weekly")
    assert_equal Date.new(2026, 10, 21), Finance::Domain.next_occurrence("2026-10-15", "2026-10-20", "daily", 2)
    assert_equal Date.new(2025, 2, 28), Finance::Domain.next_occurrence("2024-02-29", "2024-02-29", "yearly")
    assert_equal [Date.new(2026, 9, 10), Date.new(2026, 10, 9)], Finance::Domain.period_bounds(Date.new(2026, 10, 3), "month", 10)
    assert_equal [Date.new(2026, 12, 10), Date.new(2027, 1, 9)], Finance::Domain.period_bounds(Date.new(2026, 12, 20), "month", 10)
    assert_equal "warning", Finance::Domain.budget_status(BigDecimal(90), BigDecimal(100))[:level]
    assert_equal "over", Finance::Domain.budget_status(BigDecimal("100.01"), BigDecimal(100))[:level]
  end

  test "Appendix 2 scenario in PostgreSQL: totals, balances and net worth through the app's services" do
    scenario = fixture("ledger/appendix2-scenario.json")
    user = create(:onboarded_user, usage_region: "US")
    Finance::Profile.create!(user: user, currency: scenario["currency"])
    accounts = scenario["accounts"].to_h do |a|
      [a["id"], Finance::BankAccount.create!(user: user, manual: true, name: a["id"], account_type: a["type"],
        opening_balance: BigDecimal(a["openingBalanceMinor"]) / 100, include_in_net_worth: a.fetch("includeInNetWorth", true))]
    end
    entries = scenario["entries"].to_h do |e|
      record = Finance::Transaction.create!(user: user, bank_account: accounts.fetch(e["accountId"]), entry_origin: "manual",
        booked_on: Date.iso8601(e["occurredOn"]), amount: BigDecimal(e["amountMinor"]) / 100, kind: e["kind"], category: e["category"],
        description: e["id"], excluded: e.fetch("excluded", false), deleted_at: e["deleted"] ? Time.current : nil)
      [e["id"], record]
    end
    scenario["links"].each do |l|
      Finance::TransactionLink.create!(user: user, link_type: l["type"], from_transaction: entries[l["from"]], to_transaction: entries[l["to"]],
        amount: l["amountMinor"] && BigDecimal(l["amountMinor"]) / 100)
    end
    cents = ->(value) { (value.to_d * 100).to_i }

    october = scenario["expected"]["october"]
    snapshot = Finance::Snapshot.new(user: user, start_date: Date.iso8601(october["from"]), end_date: Date.iso8601(october["to"])).to_h
    assert_equal october["incomeMinor"], cents.call(snapshot[:income])
    assert_equal october["expenseMinor"], cents.call(snapshot[:expenses])
    assert_equal october["netMinor"], cents.call(snapshot[:net])
    assert_equal october["expenseByCategory"], snapshot[:categories].to_h { |c| [c[:name], cents.call(c[:amount])] }
    report = Finance::LedgerReport.new(user: user, start_date: Date.iso8601(october["from"]), end_date: Date.iso8601(october["to"]))
    assert_equal october["incomeByCategory"], report.income_by_category.to_h { |name, amount| [name, cents.call(amount)] }

    all = Finance::Snapshot.new(user: user).to_h
    assert_equal scenario["expected"]["allTime"].values_at("incomeMinor", "expenseMinor", "netMinor"), [all[:income], all[:expenses], all[:net]].map(&cents)

    as_of = Finance::BankAccount.balances_for(user, as_of: Date.new(2026, 10, 31))
    assert_equal scenario["expected"]["balancesAsOf2026-10-31"], accounts.transform_values { |a| cents.call(as_of[a.id]) }
    all_balances = Finance::BankAccount.balances_for(user)
    assert_equal scenario["expected"]["balancesAllTime"], accounts.transform_values { |a| cents.call(all_balances[a.id]) }
    worth = Finance::BankAccount.net_worth_for(user)
    assert_equal scenario["expected"]["netWorthAllTime"], {"assetsMinor" => cents.call(worth[:assets]), "liabilitiesMinor" => cents.call(worth[:liabilities]), "netWorthMinor" => cents.call(worth[:net_worth])}

    refunded = Finance::TransactionLink.where(link_type: "refund_of", to_transaction: entries["t2"]).sum(:amount)
    assert_equal scenario["expected"]["refundableOf_t2"], cents.call(Finance::Domain.refundable(entries["t2"].amount, [refunded]))

    # Same answers from the plain-hash domain helper the clients mirror.
    plain = scenario["entries"].map { |e| {occurred_on: e["occurredOn"], amount: BigDecimal(e["amountMinor"]) / 100, kind: e["kind"], category: e["category"], excluded: e["excluded"], deleted: e["deleted"]} }
    totals = Finance::Domain.totals(plain, from: october["from"], to: october["to"])
    assert_equal october["incomeMinor"], cents.call(totals[:income])
    assert_equal october["expenseMinor"], cents.call(totals[:expense])
  end
end
