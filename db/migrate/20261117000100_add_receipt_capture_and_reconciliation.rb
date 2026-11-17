# Multi-source capture: receipts as evidence, receipt ↔ entry matches, and Shortcuts capture tokens
# (docs/architecture/receipt-capture-and-reconciliation.md).
#
# Purely additive. No existing row or value changes:
# - two new tables hold receipts (raw evidence + the OCR/AI extraction, kept apart from bank data) and
#   matching decisions (suggested / confirmed / rejected, with who decided and why);
# - finance_transactions gains `superseded_by_id`: an entry recorded from a receipt is set aside (not
#   deleted) when the bank's own row for the same purchase arrives, so one purchase counts once. Only
#   receipt entries can be superseded — the database refuses it for bank rows;
# - entry_origin gains "receipt" (the CHECK is widened, existing values stay valid);
# - finance_capture_tokens: revocable, receipt-upload-only tokens for iOS Shortcuts (only a SHA-256
#   digest is stored).
# Every reference carries the owner (composite foreign keys, invariant I-7).
#
# Rollback removes the new structures and is refused while receipt entries exist, because narrowing
# the entry_origin CHECK would then fail or lose information.
class AddReceiptCaptureAndReconciliation < ActiveRecord::Migration[8.1]
  ORIGINS_BEFORE = %w[import manual web_copy upload recurring legacy].freeze
  ORIGINS_AFTER = (ORIGINS_BEFORE + ["receipt"]).freeze

  def up
    create_table :finance_receipts do |t|
      t.bigint :user_id, null: false
      t.uuid :uuid, null: false, default: -> { "gen_random_uuid()" }
      t.string :source, null: false, default: "upload"
      t.string :status, null: false, default: "needs_review"
      t.string :client_request_id, limit: 100
      t.string :filename, limit: 255
      t.string :content_type, limit: 100
      t.bigint :byte_size
      t.string :sha256, limit: 64
      t.string :extraction_engine, limit: 60
      t.text :ocr_text
      t.jsonb :extraction, null: false, default: {}
      t.jsonb :issues, null: false, default: []
      t.string :merchant_name, limit: 200
      t.date :purchased_on
      t.string :purchased_at_time, limit: 5
      t.decimal :total, precision: 15, scale: 2
      t.decimal :subtotal, precision: 15, scale: 2
      t.decimal :tax, precision: 15, scale: 2
      t.decimal :tip, precision: 15, scale: 2
      t.decimal :discount, precision: 15, scale: 2
      t.string :currency, limit: 3
      t.string :direction, null: false, default: "purchase"
      t.string :payment_method, limit: 20
      t.string :card_last4, limit: 4
      t.string :receipt_number, limit: 64
      t.string :category
      t.jsonb :line_items, null: false, default: []
      t.jsonb :confirmed_fields, null: false, default: []
      t.datetime :reviewed_at
      t.bigint :bank_account_id
      t.bigint :transaction_id
      t.bigint :duplicate_of_id
      t.timestamps
    end
    add_foreign_key :finance_receipts, :users
    add_index :finance_receipts, :uuid, unique: true
    add_index :finance_receipts, [:id, :user_id], unique: true, name: "index_finance_receipts_on_id_and_owner"
    add_index :finance_receipts, [:user_id, :sha256], unique: true, where: "sha256 IS NOT NULL", name: "index_finance_receipts_one_file"
    add_index :finance_receipts, [:user_id, :client_request_id], unique: true, where: "client_request_id IS NOT NULL", name: "index_finance_receipts_idempotency"
    add_index :finance_receipts, [:user_id, :status, :purchased_on], name: "index_finance_receipts_on_owner_status_date"
    add_index :finance_receipts, :transaction_id, unique: true, where: "transaction_id IS NOT NULL", name: "index_finance_receipts_one_entry"
    add_index :finance_receipts, :duplicate_of_id, where: "duplicate_of_id IS NOT NULL"
    {
      "finance_receipts_status" => "status IN ('needs_review', 'possible_duplicate', 'duplicate', 'pending_bank_match', 'cash', 'matched', 'dismissed')",
      "finance_receipts_source" => "source IN ('camera', 'upload', 'shortcut', 'app', 'email', 'manual')",
      "finance_receipts_direction" => "direction IN ('purchase', 'refund')",
      "finance_receipts_payment_method" => "payment_method IS NULL OR payment_method IN ('card', 'cash', 'mobile', 'other')",
      "finance_receipts_sha256" => "sha256 IS NULL OR sha256 ~ '^[0-9a-f]{64}$'",
      "finance_receipts_money" => "(total IS NULL OR (total >= 0 AND total < 10000000000000)) AND (subtotal IS NULL OR abs(subtotal) < 10000000000000) AND " \
        "(tax IS NULL OR abs(tax) < 10000000000000) AND (tip IS NULL OR (tip >= 0 AND tip < 10000000000000)) AND (discount IS NULL OR (discount >= 0 AND discount < 10000000000000))",
      "finance_receipts_currency" => "currency IS NULL OR currency ~ '^[A-Z]{3}$'",
      "finance_receipts_card_last4" => "card_last4 IS NULL OR card_last4 ~ '^[0-9]{4}$'",
      "finance_receipts_time" => "purchased_at_time IS NULL OR purchased_at_time ~ '^[0-2][0-9]:[0-5][0-9]$'",
      "finance_receipts_json_shapes" => "jsonb_typeof(extraction) = 'object' AND jsonb_typeof(issues) = 'array' AND jsonb_typeof(line_items) = 'array' AND jsonb_typeof(confirmed_fields) = 'array'",
      "finance_receipts_not_own_duplicate" => "duplicate_of_id IS NULL OR duplicate_of_id <> id",
      "finance_receipts_duplicate_status" => "(status IN ('duplicate', 'possible_duplicate')) = (duplicate_of_id IS NOT NULL)",
      "finance_receipts_byte_size" => "byte_size IS NULL OR (byte_size > 0 AND byte_size <= 10485760)"
    }.each { |name, expression| add_check_constraint :finance_receipts, expression, name: name }
    owner_key :finance_receipts, :finance_bank_accounts, :bank_account_id
    owner_key :finance_receipts, :finance_transactions, :transaction_id
    owner_key :finance_receipts, :finance_receipts, :duplicate_of_id

    create_table :finance_receipt_matches do |t|
      t.bigint :user_id, null: false
      t.uuid :uuid, null: false, default: -> { "gen_random_uuid()" }
      t.bigint :receipt_id, null: false
      t.bigint :transaction_id, null: false
      t.string :status, null: false, default: "suggested"
      t.string :level, null: false
      t.integer :score, null: false, default: 0
      t.jsonb :reasons, null: false, default: []
      t.uuid :group_key
      t.string :decided_by, null: false, default: "auto"
      t.datetime :decided_at
      t.timestamps
    end
    add_foreign_key :finance_receipt_matches, :users
    add_index :finance_receipt_matches, :uuid, unique: true
    add_index :finance_receipt_matches, [:receipt_id, :transaction_id], unique: true, name: "index_finance_receipt_matches_pair"
    # A bank charge is evidenced by at most one receipt (a receipt may cover several charges: split payment).
    add_index :finance_receipt_matches, :transaction_id, unique: true, where: "status = 'confirmed'", name: "index_finance_receipt_matches_one_receipt"
    add_index :finance_receipt_matches, [:user_id, :status], name: "index_finance_receipt_matches_on_owner_status"
    {
      "finance_receipt_matches_status" => "status IN ('suggested', 'confirmed', 'rejected')",
      "finance_receipt_matches_level" => "level IN ('exact', 'probable', 'ambiguous', 'manual')",
      "finance_receipt_matches_decided_by" => "decided_by IN ('user', 'auto')",
      "finance_receipt_matches_score" => "score >= 0 AND score <= 100",
      "finance_receipt_matches_reasons" => "jsonb_typeof(reasons) = 'array'",
      "finance_receipt_matches_decided" => "status = 'suggested' OR decided_at IS NOT NULL",
      # Only an exact match may be confirmed without a person.
      "finance_receipt_matches_auto_exact" => "NOT (status = 'confirmed' AND decided_by = 'auto' AND level <> 'exact')"
    }.each { |name, expression| add_check_constraint :finance_receipt_matches, expression, name: name }
    owner_key :finance_receipt_matches, :finance_receipts, :receipt_id, on_delete: :cascade
    owner_key :finance_receipt_matches, :finance_transactions, :transaction_id, on_delete: :cascade

    add_column :finance_transactions, :superseded_by_id, :bigint
    add_index :finance_transactions, :superseded_by_id, where: "superseded_by_id IS NOT NULL", name: "index_finance_transactions_on_superseded_by"
    owner_key :finance_transactions, :finance_transactions, :superseded_by_id
    replace_check :finance_transactions, "finance_transactions_entry_origin", "entry_origin IN (#{quoted(ORIGINS_AFTER)})"
    replace_check :finance_transactions, "finance_transactions_statement_or_manual", "statement_id IS NOT NULL OR entry_origin IN ('manual', 'recurring', 'receipt')"
    # Bank evidence is never set aside: only an entry recorded from a receipt can be superseded.
    add_check_constraint :finance_transactions, "superseded_by_id IS NULL OR (superseded_by_id <> id AND entry_origin = 'receipt')", name: "finance_transactions_superseded_receipt_only"

    create_table :finance_capture_tokens do |t|
      t.bigint :user_id, null: false
      t.string :name, null: false, limit: 60
      t.string :token_digest, null: false, limit: 64
      t.string :token_prefix, null: false, limit: 12
      t.datetime :last_used_at
      t.datetime :expires_at, null: false
      t.datetime :revoked_at
      t.timestamps
    end
    add_foreign_key :finance_capture_tokens, :users
    add_index :finance_capture_tokens, :token_digest, unique: true
    add_index :finance_capture_tokens, [:user_id, :revoked_at]
    add_check_constraint :finance_capture_tokens, "token_digest ~ '^[0-9a-f]{64}$'", name: "finance_capture_tokens_digest"
  end

  def down
    if select_value("SELECT 1 FROM finance_transactions WHERE entry_origin = 'receipt' LIMIT 1")
      raise ActiveRecord::IrreversibleMigration, "Entries recorded from receipts exist. Export or move them before rolling back; nothing was changed."
    end
    remove_check_constraint :finance_transactions, name: "finance_transactions_superseded_receipt_only"
    replace_check :finance_transactions, "finance_transactions_statement_or_manual", "statement_id IS NOT NULL OR entry_origin IN ('manual', 'recurring')"
    replace_check :finance_transactions, "finance_transactions_entry_origin", "entry_origin IN (#{quoted(ORIGINS_BEFORE)})"
    remove_foreign_key :finance_transactions, name: "fk_finance_transactions_superseded_by_id_owner"
    remove_index :finance_transactions, name: "index_finance_transactions_on_superseded_by"
    remove_column :finance_transactions, :superseded_by_id
    drop_table :finance_capture_tokens
    drop_table :finance_receipt_matches
    drop_table :finance_receipts
  end

  private

  def owner_key(child, parent, column, on_delete: nil)
    add_foreign_key child, parent, column: [column, :user_id], primary_key: [:id, :user_id], on_delete: on_delete,
      name: "fk_#{child}_#{column}_owner"
  end

  def replace_check(table, name, expression)
    remove_check_constraint table, name: name
    add_check_constraint table, expression, name: name
  end

  def quoted(values) = values.map { |value| "'#{value}'" }.join(", ")
end
