require "test_helper"

# Manual bookkeeping without AI (finance-domain-spec §2): create, edit, delete, restore and purge entries
# of every kind, with balances, totals and the audit trail kept right.
class Finance::LedgerTest < ActiveSupport::TestCase
  setup do
    @user = create(:onboarded_user, usage_region: "US")
    Finance::Profile.create!(user: @user, currency: "USD")
    @ledger = Finance::Ledger.new(@user)
    @checking = Finance::BankAccount.create!(user: @user, manual: true, name: "Checking", account_type: "checking", opening_balance: 1000)
    @card = Finance::BankAccount.create!(user: @user, manual: true, name: "Card", account_type: "credit_card")
    @cash = Finance::BankAccount.create!(user: @user, manual: true, name: "Wallet", account_type: "cash", opening_balance: 50)
  end

  def balances = Finance::BankAccount.balances_for(@user).transform_keys { |id| Finance::BankAccount.find(id).name }
  def snapshot = Finance::Snapshot.new(user: @user).to_h

  test "expense, income, refund and card payment: totals by kind, balances by account" do
    purchase = @ledger.create(kind: "expense", amount: "80.00", booked_on: "2026-10-09", account_id: @card.id, category: "Shopping", merchant_name: "ZXQ Outfitters", tag_names: "gift, trip")
    assert_equal BigDecimal("-80"), purchase.amount
    assert_equal ["gift", "trip"], purchase.tags.map(&:name).sort
    assert_equal "ZXQ Outfitters", purchase.description
    @ledger.create(kind: "income", amount: "2000", booked_on: "2026-10-30", account_id: @checking.id, category: "Income")
    refund = @ledger.create(kind: "refund", amount: "30", booked_on: "2026-10-15", account_id: @card.id, refund_of_id: purchase.id)
    assert_equal ["refund", "Shopping", BigDecimal(30)], [refund.kind, refund.category, refund.amount]
    assert_equal purchase.merchant, refund.merchant
    payment = @ledger.create(kind: "transfer", amount: "50", booked_on: "2026-10-28", account_id: @checking.id, to_account_id: @card.id)
    assert_equal "card_payment", payment.kind, "a transfer into a credit card is a card payment"

    assert_equal BigDecimal(2000), snapshot[:income]
    assert_equal BigDecimal(50), snapshot[:expenses], "80 - 30; the card payment is not an expense"
    assert_equal({"Checking" => BigDecimal(2950), "Card" => BigDecimal(0), "Wallet" => BigDecimal(50)}, balances)
    assert_equal %w[card_payment refund_of], Finance::TransactionLink.pluck(:link_type).sort
  end

  test "partial refunds are capped by what is left of the expense" do
    purchase = @ledger.create(kind: "expense", amount: "80", booked_on: "2026-10-09", account_id: @card.id, category: "Shopping")
    @ledger.create(kind: "refund", amount: "50", booked_on: "2026-10-10", account_id: @card.id, refund_of_id: purchase.id)
    error = assert_raises(Finance::Ledger::Invalid) { @ledger.create(kind: "refund", amount: "31", booked_on: "2026-10-11", account_id: @card.id, refund_of_id: purchase.id) }
    assert_equal ["refund_too_large"], error.codes
    @ledger.create(kind: "refund", amount: "30", booked_on: "2026-10-11", account_id: @card.id, refund_of_id: purchase.id)
  end

  test "validation codes match the shared entryProblems" do
    assert_equal ["amount_zero"], assert_raises(Finance::Ledger::Invalid) { @ledger.create(kind: "expense", amount: "0", booked_on: "2026-10-01", account_id: @cash.id) }.codes
    assert_equal ["account_required"], assert_raises(Finance::Ledger::Invalid) { @ledger.create(kind: "expense", amount: "1", booked_on: "2026-10-01") }.codes
    assert_equal ["date_invalid"], assert_raises(Finance::Ledger::Invalid) { @ledger.create(kind: "expense", amount: "1", booked_on: "2026-02-30", account_id: @cash.id) }.codes
    assert_equal ["accounts_same"], assert_raises(Finance::Ledger::Invalid) { @ledger.create(kind: "transfer", amount: "1", booked_on: "2026-10-01", account_id: @cash.id, to_account_id: @cash.id) }.codes
    assert_equal ["category_kind"], assert_raises(Finance::Ledger::Invalid) { @ledger.create(kind: "expense", amount: "1", booked_on: "2026-10-01", account_id: @cash.id, category: "Income") }.codes
    assert_equal ["amount_precision"], assert_raises(Finance::Ledger::Invalid) { @ledger.create(kind: "expense", amount: "1.005", booked_on: "2026-10-01", account_id: @cash.id) }.codes
    other = create(:onboarded_user)
    foreign = Finance::BankAccount.create!(user: other, manual: true, name: "Not mine", account_type: "cash")
    assert_equal ["not_found"], assert_raises(Finance::Ledger::Invalid) { @ledger.create(kind: "expense", amount: "1", booked_on: "2026-10-01", account_id: foreign.id) }.codes
  end

  test "editing a manual entry changes amount, account and category; editing a transfer keeps both legs balanced" do
    entry = @ledger.create(kind: "expense", amount: "12.50", booked_on: "2026-10-12", account_id: @cash.id, category: "Food & dining")
    @ledger.update(entry, amount: "15", account_id: @checking.id, category: "Health", note: "pharmacy")
    entry.reload
    assert_equal [BigDecimal(-15), @checking.id, "Health", "pharmacy"], [entry.amount, entry.bank_account_id, entry.category, entry.note]
    assert_includes entry.user_locked_fields, "category"

    leg = @ledger.create(kind: "transfer", amount: "200", booked_on: "2026-10-20", account_id: @checking.id, to_account_id: @cash.id)
    @ledger.update(leg, amount: "120")
    other = Finance::Transaction.where(kind: "transfer").where.not(id: leg.id).sole
    assert_equal [BigDecimal(-120), BigDecimal(120)], [leg.reload.amount, other.amount]
    assert_equal BigDecimal(170), balances["Wallet"]
  end

  test "imported entries keep the bank's amount, date and original text" do
    statement = Finance::Statement.create!(user: @user, filename: "a.csv", currency: "USD", sha256: "a" * 64, transaction_count: 1)
    imported = Finance::Transaction.create!(user: @user, statement: statement, booked_on: Date.new(2026, 10, 31), description: "ZELLE TO SAM Q", amount: -60, category: "Uncategorized")
    @ledger.update(imported, amount: "1", booked_on: "2020-01-01", description: "Dinner split with Sam", category: "Food & dining")
    imported.reload
    assert_equal [BigDecimal(-60), Date.new(2026, 10, 31), "ZELLE TO SAM Q", "Dinner split with Sam", "Food & dining"],
      [imported.amount, imported.booked_on, imported.original_description, imported.description, imported.category]
    assert_equal %w[category description].sort, (imported.user_locked_fields & %w[category description]).sort
  end

  test "delete goes to the trash (both legs of a transfer), restore brings it back, purge removes manual entries only" do
    leg = @ledger.create(kind: "transfer", amount: "20", booked_on: "2026-10-20", account_id: @checking.id, to_account_id: @cash.id)
    @ledger.delete(leg)
    assert_equal 2, Finance::Transaction.trashed.count
    assert_equal({"Checking" => BigDecimal(1000), "Card" => BigDecimal(0), "Wallet" => BigDecimal(50)}, balances)
    @ledger.restore(leg)
    assert_equal 0, Finance::Transaction.trashed.count
    @ledger.delete(leg)
    @ledger.purge(leg)
    assert_equal 0, Finance::Transaction.count
    assert_equal %w[create create delete delete restore restore delete delete purge purge], Finance::AuditEvent.order(:id).pluck(:action)
  end

  test "balance adjustment brings an account to the balance the person sees" do
    @ledger.create(kind: "expense", amount: "12.50", booked_on: "2026-10-12", account_id: @cash.id)
    adjustment = @ledger.adjust_balance(@cash, "30.00", on: Date.new(2026, 10, 25))
    assert_equal ["adjustment", BigDecimal("-7.5")], [adjustment.kind, adjustment.amount]
    assert_equal BigDecimal(30), balances["Wallet"]
    assert_equal BigDecimal("12.5"), snapshot[:expenses], "an adjustment is never income or expense"
  end

  test "batch edit and its undo restore exactly the previous values" do
    a = @ledger.create(kind: "expense", amount: "5", booked_on: "2026-10-01", account_id: @cash.id)
    b = @ledger.create(kind: "expense", amount: "6", booked_on: "2026-10-02", account_id: @cash.id, category: "Health")
    assert_equal 2, @ledger.batch([a.id, b.id], {action: "category", value: "Shopping"})
    batch_id = Finance::AuditEvent.where(action: "batch_update").pick(:batch_id)
    assert_equal %w[Shopping Shopping], [a.reload.category, b.reload.category]
    assert_equal({undone: 2, skipped: 0}, @ledger.undo_batch(batch_id))
    assert_equal %w[Uncategorized Health], [a.reload.category, b.reload.category]
    assert_equal({undone: 0, skipped: 2}, @ledger.undo_batch(batch_id), "undoing a batch twice must not replay its undo events")
  end

  test "batch tag undo restores the prior tags" do
    entry = @ledger.create(kind: "expense", amount: "5", booked_on: "2026-10-01", account_id: @cash.id, tag_names: "original")
    tag = Finance::Tag.create!(user: @user, name: "added")
    @ledger.batch([entry.id], {action: "tag", value: tag.id})
    batch_id = Finance::AuditEvent.where(action: "batch_update").pick(:batch_id)
    assert_equal %w[added original], entry.reload.tags.order(:name).pluck(:name)
    assert_equal({undone: 1, skipped: 0}, @ledger.undo_batch(batch_id))
    assert_equal ["original"], entry.reload.tags.pluck(:name)
  end

  test "audit events are read-only once saved" do
    entry = @ledger.create(kind: "expense", amount: "5", booked_on: "2026-10-01", account_id: @cash.id)
    event = Finance::AuditEvent.where(subject_id: entry.id.to_s).sole
    assert_equal({"amount" => "-5.0"}, event.changes_data["after"].slice("amount"))
    assert_raises(ActiveRecord::ReadOnlyRecord) { event.update!(action: "delete") }
  end

  test "a trashed refund cannot be restored after its allowance has been reused" do
    purchase = @ledger.create(kind: "expense", amount: "80", booked_on: "2026-10-01", account_id: @card.id)
    refund = @ledger.create(kind: "refund", amount: "50", booked_on: "2026-10-02", account_id: @card.id, refund_of_id: purchase.id)
    @ledger.delete(refund)
    @ledger.create(kind: "refund", amount: "80", booked_on: "2026-10-03", account_id: @card.id, refund_of_id: purchase.id)
    assert_equal ["refund_too_large"], assert_raises(Finance::Ledger::Invalid) { @ledger.restore(refund) }.codes
    assert_not_nil refund.reload.deleted_at
  end

  test "an expense cannot be reduced or reclassified below its posted refunds" do
    purchase = @ledger.create(kind: "expense", amount: "80", booked_on: "2026-10-01", account_id: @card.id)
    @ledger.create(kind: "refund", amount: "50", booked_on: "2026-10-02", account_id: @card.id, refund_of_id: purchase.id)
    assert_raises(Finance::Ledger::Invalid) { @ledger.update(purchase, amount: "40") }
    assert_equal BigDecimal("-80"), purchase.reload.amount
    assert_raises(Finance::Ledger::Invalid) { @ledger.update(purchase, kind: "income", category: "Income") }
    assert_equal "expense", purchase.reload.kind
  end

  test "reclassifying a refund releases its link and refundable allowance" do
    purchase = @ledger.create(kind: "expense", amount: "80", booked_on: "2026-10-01", account_id: @card.id)
    refund = @ledger.create(kind: "refund", amount: "50", booked_on: "2026-10-02", account_id: @card.id, refund_of_id: purchase.id)
    @ledger.update(refund, kind: "income", category: "Income")
    assert_empty refund.outgoing_links.where(link_type: "refund_of")
    @ledger.create(kind: "refund", amount: "80", booked_on: "2026-10-03", account_id: @card.id, refund_of_id: purchase.id)
  end
  test "category normalization cannot turn a refunded imported expense into a transfer" do
    statement = Finance::Statement.create!(user: @user, filename: "synthetic-expense.csv", currency: "USD", sha256: "7" * 64, transaction_count: 1)
    purchase = Finance::Transaction.create!(user: @user, statement: statement, bank_account: @card, entry_origin: "import", kind: "expense",
      amount: "-80", booked_on: "2026-10-01", description: "Synthetic purchase", category: "Shopping")
    @ledger.create(kind: "refund", amount: "50", booked_on: "2026-10-02", account_id: @card.id, refund_of_id: purchase.id)
    assert_raises(Finance::Ledger::Invalid) { @ledger.update(purchase, category: "Transfers") }
    assert_equal "expense", purchase.reload.kind
  end

  test "normalizing an imported refund into income releases its old refund relation" do
    purchase = @ledger.create(kind: "expense", amount: "80", booked_on: "2026-10-01", account_id: @card.id)
    statement = Finance::Statement.create!(user: @user, filename: "synthetic.csv", currency: "USD", sha256: "8" * 64, transaction_count: 1)
    refund = Finance::Transaction.create!(user: @user, statement: statement, bank_account: @card, entry_origin: "import", kind: "refund",
      amount: "50", booked_on: "2026-10-02", description: "Synthetic bank credit", category: "Shopping")
    Finance::TransactionLink.create!(user: @user, link_type: "refund_of", from_transaction: refund, to_transaction: purchase, amount: "50", status: "confirmed", decided_by: "user")
    @ledger.update(refund, category: "Income")
    assert_equal "income", refund.reload.kind
    assert_empty refund.outgoing_links.where(link_type: "refund_of")
  end
end
