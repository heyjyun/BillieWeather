# Finance domain v2 (docs/architecture/finance-domain-spec.md §3). Additive only.
# Backfill reproduces today's totals exactly: kind = legacyKind (Transfers category -> transfer,
# amount > 0 -> income, otherwise expense). Rows that look like refunds or card repayments are listed
# for review in the app; nothing is reclassified silently. original_description = description
# (earlier edits cannot be recovered; from now on the original is never overwritten).
class AddLedgerColumnsToFinanceTransactions < ActiveRecord::Migration[8.1]
  KINDS = %w[expense income refund transfer card_payment opening_balance adjustment ignored].freeze
  ORIGINS = %w[import manual web_copy upload recurring legacy].freeze

  def up
    change_table :finance_transactions, bulk: true do |t|
      t.uuid :uuid, null: false, default: -> { "gen_random_uuid()" }
      t.string :kind, null: false, default: "expense"
      t.string :original_description, limit: 500
      t.bigint :bank_account_id
      t.string :entry_origin, null: false, default: "import"
      t.datetime :deleted_at
      t.string :category_source, null: false, default: "legacy"
      t.integer :category_confidence
      t.string :category_model
      t.jsonb :user_locked_fields, null: false, default: []
      t.text :note
      t.bigint :merchant_id
      t.bigint :project_id
      t.string :occurred_at_time, limit: 5
      t.bigint :recurring_rule_id
      t.date :recurring_on
      t.bigint :book_id
      t.string :fingerprint
    end
    execute <<~SQL
      UPDATE finance_transactions SET
        kind = CASE WHEN category = 'Transfers' THEN 'transfer' WHEN amount > 0 THEN 'income' ELSE 'expense' END,
        original_description = description
    SQL
    execute <<~SQL
      UPDATE finance_transactions t SET bank_account_id = s.bank_account_id
      FROM finance_statements s WHERE s.id = t.statement_id AND s.bank_account_id IS NOT NULL
    SQL
    change_column_null :finance_transactions, :original_description, false
    change_column_null :finance_transactions, :statement_id, true
    add_check_constraint :finance_transactions, "kind IN (#{KINDS.map { |k| "'#{k}'" }.join(", ")})", name: "finance_transactions_kind"
    add_check_constraint :finance_transactions, "entry_origin IN (#{ORIGINS.map { |k| "'#{k}'" }.join(", ")})", name: "finance_transactions_entry_origin"
    add_check_constraint :finance_transactions, "statement_id IS NOT NULL OR entry_origin IN ('manual', 'recurring')", name: "finance_transactions_statement_or_manual"
    add_check_constraint :finance_transactions, "occurred_at_time IS NULL OR occurred_at_time ~ '^[0-2][0-9]:[0-5][0-9]$'", name: "finance_transactions_time"
    add_index :finance_transactions, :uuid, unique: true
    add_index :finance_transactions, [:user_id, :kind]
    add_index :finance_transactions, [:bank_account_id, :booked_on, :amount], name: "index_finance_transactions_on_account_date_amount"
    add_index :finance_transactions, [:user_id, :deleted_at]
    add_index :finance_transactions, :fingerprint
    add_index :finance_transactions, [:recurring_rule_id, :recurring_on, :bank_account_id], unique: true, where: "recurring_rule_id IS NOT NULL", name: "index_finance_transactions_recurring_once"
    add_foreign_key :finance_transactions, :finance_bank_accounts, column: :bank_account_id
  end

  def down
    remove_foreign_key :finance_transactions, column: :bank_account_id
    %w[finance_transactions_kind finance_transactions_entry_origin finance_transactions_statement_or_manual finance_transactions_time].each do |name|
      remove_check_constraint :finance_transactions, name: name
    end
    # statement_id stays nullable on rollback if manual rows exist; otherwise restore NOT NULL.
    change_column_null :finance_transactions, :statement_id, false unless select_value("SELECT 1 FROM finance_transactions WHERE statement_id IS NULL LIMIT 1")
    remove_columns :finance_transactions, :uuid, :kind, :original_description, :bank_account_id, :entry_origin, :deleted_at, :category_source,
      :category_confidence, :category_model, :user_locked_fields, :note, :merchant_id, :project_id, :occurred_at_time, :recurring_rule_id,
      :recurring_on, :book_id, :fingerprint
  end
end
