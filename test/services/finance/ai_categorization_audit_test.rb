require "test_helper"
require "stringio"
require_relative "../../support/billie_method_stub"

# AI categorization is auditable and undoable (Phase 0.5, audit R3). It used to write with update_all
# and leave no trace. Now every run is one "ai_apply" batch in finance_audit_events (actor "ai"),
# undone through Ledger#undo_batch, which skips rows a person changed since. Synthetic data only.
class Finance::AiCategorizationAuditTest < ActiveSupport::TestCase
  include BillieMethodStub

  CSV_TEXT = <<~CSV
    Date,Description,Amount
    2026-01-03,ZORBLAX PET SUPPLY 4421,-42.10
    2026-01-09,Zorblax Pet Supply 77,-12.00
    2026-01-12,QWERTY STUDIO,-80.00
    2026-01-15,PLONK BOOKS,-15.00
  CSV

  setup do
    @user = create(:onboarded_user, usage_region: "US")
    Finance::Profile.find_or_create_by!(user_id: @user.id) { |profile| profile.currency = "USD" }
    Finance::Profile.where(user_id: @user.id).update_all(currency: "USD")
    stream = StringIO.new(CSV_TEXT)
    stream.define_singleton_method(:original_filename) { "synthetic.csv" }
    Finance::StatementImporter.new(user: @user, file: stream, currency: "USD").call
    Finance::Transaction.where(user_id: @user.id).update_all(category: "Uncategorized", category_source: "auto")
    @zorblax = @user.finance_transactions.where("description ILIKE 'zorblax%'").order(:id).to_a
    @qwerty = @user.finance_transactions.find_by!(description: "QWERTY STUDIO")
    @plonk = @user.finance_transactions.find_by!(description: "PLONK BOOKS")
  end

  def run_ai(answers)
    stub_method(Finance::AiCategorizer, :available?, true) do
      stub_method(Finance::AiCategorizer, :suggest, ->(items:, categories:) {
        items.to_h { |item| [item[:key], answers.find { |pattern, _| item[:text].match?(pattern) }&.last] }.compact
      }) do
        Finance::AiCategorizer.new(user: @user, consent: true).call
      end
    end
  end

  def events(batch_id) = Finance::AuditEvent.where(user_id: @user.id, batch_id: batch_id).order(:id).to_a

  test "a run is one ai_apply batch with the previous values, and nothing sensitive" do
    result = run_ai([[/zorblax/i, "Shopping"], [/qwerty/i, "Health"]])
    assert_equal 3, result.updated
    assert result.batch_id.present?
    recorded = events(result.batch_id)
    assert_equal 3, recorded.length
    assert recorded.all? { |event| event.actor == "ai" && event.action == "ai_apply" && event.subject_type == "Transaction" }
    assert_equal (@zorblax + [@qwerty]).map { |entry| entry.id.to_s }.sort, recorded.map(&:subject_id).sort
    first = recorded.find { |event| event.subject_id == @zorblax.first.id.to_s }
    assert_equal "Uncategorized", first.changes_data.dig("before", "category")
    assert_equal "Shopping", first.changes_data.dig("after", "category")
    assert_equal "ai", first.changes_data.dig("after", "category_source")
    assert_equal "openai", first.changes_data.dig("after", "category_model")
    # Only classification fields: no amounts, dates or merchant text in the log.
    stored = recorded.map { |event| event.changes_data.to_json + event.summary.to_s }.join
    refute_match(/42\.1|2026-01|zorblax|qwerty/i, stored)
    assert_equal "Uncategorized", @plonk.reload.category, "a row the AI did not place is not touched or logged"
  end

  test "undo restores the previous classification" do
    result = run_ai([[/zorblax/i, "Shopping"], [/qwerty/i, "Health"]])
    undone = Finance::Ledger.new(@user).undo_batch(result.batch_id)
    assert_equal({undone: 3, skipped: 0}, undone)
    (@zorblax + [@qwerty]).each do |entry|
      entry.reload
      assert_equal ["Uncategorized", "auto", nil], [entry.category, entry.category_source, entry.category_model]
      assert_equal "expense", entry.kind
    end
    assert_equal 3, Finance::AuditEvent.where(user_id: @user.id, batch_id: result.batch_id, action: "ai_undo").count
  end

  test "undo never overwrites a later edit by a person" do
    result = run_ai([[/zorblax/i, "Shopping"]])
    edited = @zorblax.first
    Finance::Ledger.new(@user).batch([edited.id], {action: "category", value: "Food & dining"})
    later = edited.reload.category
    undone = Finance::Ledger.new(@user).undo_batch(result.batch_id)
    assert_equal({undone: 1, skipped: 1}, undone)
    assert_equal later, edited.reload.category, "the person's later choice stays"
    assert_equal "Uncategorized", @zorblax.last.reload.category
  end

  test "a failure part-way leaves no row changed and no event written" do
    calls = 0
    original = Finance::Transaction.method(:sync_kinds_for_category!)
    stub_method(Finance::Transaction, :sync_kinds_for_category!, ->(*args) {
      calls += 1
      raise ActiveRecord::StatementInvalid, "synthetic failure" if calls == 2
      original.call(*args)
    }) do
      assert_raises(ActiveRecord::StatementInvalid) { run_ai([[/zorblax/i, "Shopping"], [/qwerty/i, "Health"]]) }
    end
    assert_equal ["Uncategorized"], @user.finance_transactions.distinct.pluck(:category)
    assert_empty Finance::AuditEvent.where(user_id: @user.id, action: "ai_apply")
  end

  test "rows a person locked are neither changed nor logged" do
    @qwerty.update_columns(user_locked_fields: ["category"])
    result = run_ai([[/zorblax/i, "Shopping"], [/qwerty/i, "Health"]])
    assert_equal 2, result.updated
    assert_equal "Uncategorized", @qwerty.reload.category
    refute_includes events(result.batch_id).map(&:subject_id), @qwerty.id.to_s
  end

  test "a run that changes nothing writes no batch" do
    result = run_ai([])
    assert_equal 0, result.updated
    assert_nil result.batch_id
    assert_empty Finance::AuditEvent.where(user_id: @user.id, action: "ai_apply")
  end
end
