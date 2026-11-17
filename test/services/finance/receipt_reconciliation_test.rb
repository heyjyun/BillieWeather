require "test_helper"
require "stringio"

# Financial invariants for multi-source capture (docs/architecture/receipt-capture-and-reconciliation.md §8):
#   I-R1  One real purchase counts once, however many records describe it (receipt, bank row, copies).
#   I-R2  Matching never edits, deletes or supersedes authoritative bank rows.
#   I-R3  Nothing uncertain is shown as verified; only exact matches are linked without a person.
#   I-R4  Every decision is reversible and audited; repeated runs change nothing.
# Synthetic data only.
class Finance::ReceiptReconciliationTest < ActiveSupport::TestCase
  setup do
    @user = create(:onboarded_user, usage_region: "US")
    Finance::Profile.find_or_create_by!(user_id: @user.id) { |profile| profile.currency = "USD" }
    Finance::Profile.where(user_id: @user.id).update_all(currency: "USD")
  end

  WHOLE_FOODS = ["WHOLE FOODS MARKET", "2525 Lamar Blvd", "Austin, TX 78705", "11/16/2026 6:42 PM", "ORGANIC BANANAS 1.98", "SUBTOTAL 44.94", "TAX 3.66",
    "TOTAL 48.60", "VISA **** 4821 48.60", "TRANS# 004512"].freeze

  def capture(lines = WHOLE_FOODS, user: @user, **options)
    Finance::ReceiptIngestion.call(user: user, source: "app", lines: lines.map { |text| {text: text, confidence: 0.95} }, **options)
  end

  def import_csv(rows, name: "bank-#{SecureRandom.hex(4)}.csv", user: @user)
    body = "Date,Description,Amount\n" + rows.map { |date, description, amount| "#{date},#{description},#{amount}" }.join("\n") + "\n"
    stream = StringIO.new(body)
    stream.define_singleton_method(:original_filename) { name }
    Finance::StatementImporter.new(user: user, file: stream, currency: "USD").call
  end

  def spending(user = @user) = -Finance::Transaction.included.where(user_id: user.id, kind: %w[expense refund]).sum(:amount)

  def reconciler = Finance::ReceiptReconciler.new(@user)

  test "I-R1 the Whole Foods example: receipt first, bank row later → one $48.60 expense, one receipt, one bank row" do
    receipt = capture.receipt
    assert_equal "pending_bank_match", receipt.status
    assert_equal BigDecimal("48.60"), spending
    receipt_entry = receipt.entry
    assert_equal "receipt", receipt_entry.entry_origin

    import_csv([["2026-11-16", "WHOLEFDS MKT #10234 AUSTIN TX", "-48.60"]])
    receipt.reload
    bank = @user.finance_transactions.find_by!(entry_origin: "import")
    assert_equal "matched", receipt.status
    assert_equal "auto_matched", receipt.verification, "an automatic match is not shown as verified"
    assert_equal [bank.id], receipt.matched_entries.map(&:id)
    assert_equal bank.id, receipt_entry.reload.superseded_by_id
    assert_equal BigDecimal("48.60"), spending, "never $97.20"
    assert_equal [bank.id], Finance::Transaction.live.where(user_id: @user.id).pluck(:id)
    # I-R2: the bank row is exactly what the bank printed.
    assert_equal ["WHOLEFDS MKT #10234 AUSTIN TX", BigDecimal("-48.60"), Date.new(2026, 11, 16), nil], bank.reload.values_at(:original_description, :amount, :booked_on, :superseded_by_id)
    # The person confirms: verified.
    reconciler.confirm(receipt.matches.confirmed.first)
    assert_equal "verified", receipt.reload.verification
  end

  test "I-R1 bank row first, receipt later: the receipt attaches, no second expense" do
    import_csv([["2026-11-16", "WHOLEFDS MKT #10234", "-48.60"]])
    receipt = capture.receipt
    assert_equal "matched", receipt.status
    assert_nil receipt.entry
    assert_equal 1, Finance::Transaction.live.where(user_id: @user.id).count
    assert_equal BigDecimal("48.60"), spending
  end

  test "I-R1 the same receipt uploaded twice, retried, or re-photographed never adds spending" do
    first = capture(client_request_id: "req-1")
    assert first.created
    retry_result = capture(client_request_id: "req-1")
    refute retry_result.created
    assert_equal first.receipt.id, retry_result.receipt.id

    file = {bytes: "%PDF-1.4 synthetic receipt", filename: "r.pdf", content_type: "application/pdf"}
    a = Finance::ReceiptIngestion.call(user: @user, source: "upload", file: file, fields: {merchant_name: "Corner Deli", purchased_on: "2026-11-15", total: "12.00"})
    b = Finance::ReceiptIngestion.call(user: @user, source: "upload", file: file)
    refute b.created
    assert_equal a.receipt.id, b.receipt.id

    cropped = capture(WHOLE_FOODS.first(8) + ["TRANS# 004512"]).receipt
    assert_equal "duplicate", cropped.status
    assert_equal first.receipt.id, cropped.duplicate_of_id
    assert_nil cropped.entry
    assert_equal BigDecimal("60.60"), spending
  end

  test "a copy without a receipt number is a possible duplicate until a person decides" do
    capture(["STARBUCKS", "2026-11-16", "LATTE 4.50", "TOTAL 4.50"])
    copy = capture(["Starbucks Store", "11/16/2026", "TOTAL 4.50"]).receipt
    assert_equal "possible_duplicate", copy.status
    assert_equal BigDecimal("4.50"), spending, "the possible copy is not counted"
    reconciler.not_duplicate(copy)
    assert_equal "pending_bank_match", copy.reload.status
    assert_equal BigDecimal("9.00"), spending, "two real coffees"
  end

  test "identical amounts at different merchants are two purchases" do
    capture
    import_csv([["2026-11-16", "SHELL OIL 5744", "-48.60"]])
    assert_equal BigDecimal("97.20"), spending
    assert_equal "pending_bank_match", Finance::Receipt.sole.status
    assert_empty Finance::ReceiptMatch.all
  end

  test "two identical bank charges: a person chooses; the receipt is not recorded meanwhile" do
    import_csv([["2026-11-16", "STARBUCKS STORE 0123", "-4.50"], ["2026-11-16", "STARBUCKS STORE 0123 ", "-4.50"]])
    receipt = capture(["STARBUCKS", "2026-11-16", "TOTAL 4.50"]).receipt
    assert_equal "needs_review", receipt.verification
    assert_nil receipt.entry
    assert_equal 2, receipt.suggested_matches.length
    assert(receipt.suggested_matches.all? { |match| match.level == "ambiguous" })
    assert_equal BigDecimal("9.00"), spending
    reconciler.confirm(receipt.suggested_matches.first)
    assert_equal "verified", receipt.reload.verification
    assert_equal BigDecimal("9.00"), spending
    assert_empty receipt.suggested_matches
  end

  test "delayed posting: a probable match waits for a person, then counts once" do
    receipt = capture.receipt
    import_csv([["2026-11-21", "WHOLEFDS MKT", "-48.60"]])
    receipt.reload
    match = receipt.matches.sole
    assert_equal ["suggested", "probable"], [match.status, match.level]
    assert_equal "needs_review", receipt.verification
    reconciler.confirm(match)
    assert_equal BigDecimal("48.60"), spending
    assert receipt.entry.reload.superseded?
  end

  test "I-R4 Keep separate is remembered and records nothing twice; undo restores the receipt entry" do
    import_csv([["2026-11-21", "WHOLEFDS MKT", "-48.60"]])
    receipt = capture.receipt
    match = receipt.matches.sole
    reconciler.reject(match)
    receipt.reload
    assert_equal "pending_bank_match", receipt.status
    assert_equal BigDecimal("97.20"), spending, "the person said these are two purchases"
    reconciler.process(receipt)
    assert_equal ["rejected"], receipt.reload.matches.map(&:status), "a rejected pair is never suggested again"

    reconciler.reconsider(match)
    reconciler.confirm(match.reload)
    assert_equal BigDecimal("48.60"), spending
    reconciler.undo(match.reload)
    assert_equal BigDecimal("97.20"), spending
    refute receipt.entry.reload.superseded?
    actions = Finance::AuditEvent.where(user_id: @user.id, subject_type: "Receipt").pluck(:action)
    assert_includes actions, "link"
    assert_includes actions, "unlink"
  end

  test "I-R4 repeated reconciliation runs and repeated imports are idempotent" do
    receipt = capture.receipt
    import_csv([["2026-11-16", "WHOLEFDS MKT", "-48.60"]], name: "nov.csv")
    assert_raises(Finance::StatementImporter::ImportError) { import_csv([["2026-11-16", "WHOLEFDS MKT", "-48.60"]], name: "nov.csv") }
    import_csv([["2026-11-16", "WHOLEFDS MKT", "-48.60"], ["2026-11-02", "OVERLAP ROW", "-1.00"]], name: "overlap.csv")
    3.times { reconciler.process(receipt) }
    reconciler.after_import(Finance::Transaction.where(user_id: @user.id).pluck(:id))
    assert_equal 1, Finance::ReceiptMatch.count
    assert_equal 2, Finance::Transaction.live.where(user_id: @user.id).count
    assert_equal BigDecimal("49.60"), spending
  end

  test "a refund receipt matches the bank refund and reduces net spending" do
    import_csv([["2026-11-08", "TARGET T-1123", "-21.64"], ["2026-11-14", "TARGET T-1123 REFUND", "21.64"]])
    receipt = capture(["TARGET", "11/13/2026", "Throw Pillow -19.99", "SUBTOTAL -19.99", "TAX -1.65", "REFUND TOTAL -21.64"]).receipt
    assert_equal "refund", receipt.direction
    refund = @user.finance_transactions.find_by!(amount: BigDecimal("21.64"))
    assert_equal [refund.id], receipt.matched_entries.map(&:id)
    assert_equal BigDecimal("0"), spending
  end

  test "transfers are never matched to a receipt" do
    import_csv([["2026-11-16", "ONLINE TRANSFER TO SAVINGS", "-500.00"]])
    receipt = capture(["Online Transfer", "2026-11-16", "TOTAL 500.00"]).receipt
    assert_empty receipt.matches
  end

  test "cash purchases stay counted without a bank row and are not reconciliation errors" do
    receipt = capture(["DOWNTOWN DELI", "2026-11-12", "Turkey sandwich 9.50", "TOTAL 11.50", "CASH 20.00", "CHANGE 8.50"]).receipt
    assert_equal ["cash", "cash"], [receipt.status, receipt.verification]
    assert_equal BigDecimal("11.50"), spending
    report = Finance::ReconciliationReport.new(@user, today: Date.new(2026, 12, 30))
    assert_equal [receipt.id], report.cash.map(&:id)
    assert_empty report.stale_receipts
    assert_equal 0, report.discrepancy_count
  end

  test "split payment: two charges add up to the receipt; confirming links both and counts the total once" do
    receipt = capture(["COSTCO WHOLESALE", "2026-11-16", "TOTAL 100.00"]).receipt
    import_csv([["2026-11-16", "COSTCO WHSE #0123", "-60.00"], ["2026-11-16", "COSTCO WHSE #0123", "-40.00"]])
    receipt.reload
    assert_equal 2, receipt.suggested_matches.length
    assert(receipt.suggested_matches.all? { |match| match.reason_codes.include?("split_payment") })
    reconciler.confirm(receipt.suggested_matches.first)
    receipt.reload
    assert_equal 2, receipt.confirmed_matches.length
    assert_equal "verified", receipt.verification
    assert_equal BigDecimal("100.00"), spending
  end

  test "a receipt in another currency is suggested by merchant and date but never recorded or auto-linked" do
    import_csv([["2026-11-17", "CAFE DE FLORE PARIS", "-13.02"]])
    receipt = capture(["Café de Flore", "16.11.2026 14:05", "Total 11,80 €"]).receipt
    assert_equal "EUR", receipt.currency
    assert_nil receipt.entry
    assert_equal ["ambiguous"], receipt.matches.map(&:level)
    reconciler.confirm(receipt.matches.first)
    assert_equal "foreign_currency", receipt.reload.verification
    assert_equal BigDecimal("13.02"), spending
  end

  test "I-R3 an uncertain receipt is never recorded automatically or linked without a person" do
    import_csv([["2026-11-16", "WHOLEFDS MKT", "-48.60"]])
    blurry = Finance::ReceiptIngestion.call(user: @user, source: "camera", lines: [{text: "WHOLE FOODS MARKET", confidence: 0.4}, {text: "11/16/2026", confidence: 0.5}, {text: "TOTAL 48.60", confidence: 0.45}]).receipt
    refute blurry.confident?
    assert_equal "needs_review", blurry.verification
    assert_equal ["probable"], blurry.matches.map(&:level)
    assert(blurry.matches.none? { |match| match.status == "confirmed" })
  end

  test "incorrect merchant recognition: no automatic link, the person can link by hand" do
    import_csv([["2026-11-16", "GD RESTAURANT 0042", "-31.25"]])
    receipt = capture(["G0LDEN DRAG0N", "2026-11-16", "TOTAL 31.25"]).receipt
    assert(receipt.matches.none? { |match| match.status == "confirmed" })
    bank = @user.finance_transactions.find_by!(entry_origin: "import")
    reconciler.link_manually(receipt, bank)
    assert_equal ["manual", "user"], receipt.reload.confirmed_matches.first.values_at(:level, :decided_by)
    assert_equal BigDecimal("31.25"), spending
  end

  test "I-R2 the database refuses to set a bank row aside" do
    import_csv([["2026-11-16", "WHOLEFDS MKT", "-48.60"], ["2026-11-17", "TARGET", "-5.00"]])
    bank, other = @user.finance_transactions.order(:id).to_a
    assert_raises(ActiveRecord::StatementInvalid) { bank.update_column(:superseded_by_id, other.id) }
  end

  test "removing or trashing the bank row makes the receipt's purchase count again; restoring sets it aside again" do
    receipt = capture.receipt
    import_csv([["2026-11-16", "WHOLEFDS MKT", "-48.60"]], name: "nov.csv")
    bank = @user.finance_transactions.find_by!(entry_origin: "import")
    Finance::Ledger.new(@user).delete(bank)
    assert_equal BigDecimal("48.60"), spending
    Finance::Ledger.new(@user).restore(bank)
    assert_equal BigDecimal("48.60"), spending
    assert receipt.entry.reload.superseded?

    @user.finance_statements.find_by!(filename: "nov.csv").destroy!
    receipt.reload
    assert_equal "pending_bank_match", receipt.status
    refute receipt.entry.superseded?
    assert_equal BigDecimal("48.60"), spending
  end

  test "cross-user isolation: another person's bank row is never a candidate" do
    other = create(:onboarded_user, usage_region: "US")
    Finance::Profile.find_or_create_by!(user_id: other.id) { |profile| profile.currency = "USD" }
    import_csv([["2026-11-16", "WHOLEFDS MKT", "-48.60"]], user: other)
    receipt = capture.receipt
    assert_empty receipt.matches
    assert_equal "pending_bank_match", receipt.status
    assert_equal BigDecimal("48.60"), spending(other)
    other_bank = other.finance_transactions.sole
    assert_raises(Finance::Ledger::Invalid) { reconciler.link_manually(receipt, other_bank) }
    assert_raises(Finance::Ledger::Invalid) { Finance::ReceiptReconciler.new(other).process(receipt) }
  end

  test "dashboard, ledger report and forecast inputs count a matched purchase once" do
    capture
    import_csv([["2026-11-16", "WHOLEFDS MKT", "-48.60"], ["2026-11-01", "ACME PAYROLL", "2000.00"]])
    snapshot = Finance::Snapshot.new(user: @user).to_h
    assert_equal BigDecimal("48.60"), snapshot[:expenses]
    assert_equal BigDecimal("2000.00"), snapshot[:income]
    assert_equal 2, Finance::Transaction.included.where(user_id: @user.id).count
    report = Finance::LedgerReport.new(user: @user)
    assert_equal [BigDecimal("48.60"), BigDecimal("2000.00")], [report.expense_total, report.income_total]
    assert_equal BigDecimal("48.60"), report.expense_by_category.values.sum
    # Account balances (and so the forecast's starting cash) move once.
    assert_equal BigDecimal("1951.40"), Finance::Transaction.live.where(user_id: @user.id).sum(:amount)
  end

  test "data deletion removes receipts, matches and their files" do
    receipt = Finance::ReceiptIngestion.call(user: @user, source: "upload", file: {bytes: "%PDF-1.4 synthetic", filename: "r.pdf", content_type: "application/pdf"},
      fields: {merchant_name: "Corner Deli", purchased_on: "2026-11-15", total: "12.00"}).receipt
    assert receipt.file.attached?
    blob_id = receipt.file.blob.id
    Finance::DataDeletion.call(user: @user)
    assert_equal 0, Finance::Receipt.where(user_id: @user.id).count
    refute ActiveStorage::Blob.exists?(blob_id)
  end
end
