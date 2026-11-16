# New finance domain tables (docs/architecture/finance-domain-spec.md §3). Additive only.
# Every table is owned by user_id (current tenancy); book_id prepares the Book boundary.
class CreateFinanceLedgerTables < ActiveRecord::Migration[8.1]
  def change
    create_table :finance_books do |t|
      t.references :user, null: false, foreign_key: {on_delete: :cascade}
      t.uuid :uuid, null: false, default: -> { "gen_random_uuid()" }, index: {unique: true}
      t.string :name, limit: 60, null: false
      t.string :base_currency, limit: 3, null: false
      t.string :book_type, null: false, default: "personal"
      t.integer :month_start_day, null: false, default: 1
      t.boolean :default_book, null: false, default: false
      t.datetime :archived_at
      t.timestamps
      t.check_constraint "book_type IN ('personal', 'business')", name: "finance_books_type"
      t.check_constraint "month_start_day BETWEEN 1 AND 28", name: "finance_books_month_start"
    end
    add_index :finance_books, :user_id, unique: true, where: "default_book", name: "index_finance_books_one_default"

    create_table :finance_transaction_links do |t|
      t.references :user, null: false, foreign_key: true
      t.uuid :uuid, null: false, default: -> { "gen_random_uuid()" }, index: {unique: true}
      t.string :link_type, null: false
      t.references :from_transaction, null: false, foreign_key: {to_table: :finance_transactions, on_delete: :cascade}
      t.references :to_transaction, foreign_key: {to_table: :finance_transactions, on_delete: :cascade}
      t.decimal :amount, precision: 15, scale: 2
      t.string :status, null: false, default: "confirmed"
      t.string :decided_by, null: false, default: "user"
      t.bigint :book_id
      t.timestamps
      t.check_constraint "link_type IN ('transfer', 'card_payment', 'refund_of', 'duplicate_of', 'pending_to_posted')", name: "finance_links_type"
      t.check_constraint "status IN ('suggested', 'confirmed', 'rejected')", name: "finance_links_status"
      t.check_constraint "decided_by IN ('user', 'rule', 'auto', 'ai')", name: "finance_links_decided_by"
    end
    add_index :finance_transaction_links, [:link_type, :from_transaction_id, :to_transaction_id], unique: true, name: "index_finance_links_unique"

    create_table :finance_audit_events do |t|
      t.references :user, null: false, foreign_key: true
      t.uuid :uuid, null: false, default: -> { "gen_random_uuid()" }, index: {unique: true}
      t.string :actor, null: false, default: "user"
      t.string :action, null: false
      t.string :subject_type, null: false
      t.string :subject_id
      t.uuid :batch_id
      t.string :summary, limit: 300
      t.jsonb :changes_data, null: false, default: {}
      t.jsonb :undo_data
      t.bigint :book_id
      t.datetime :created_at, null: false
    end
    add_index :finance_audit_events, [:user_id, :created_at]
    add_index :finance_audit_events, :batch_id

    %i[finance_merchants finance_projects finance_tags].each do |table|
      create_table table do |t|
        t.references :user, null: false, foreign_key: true
        t.uuid :uuid, null: false, default: -> { "gen_random_uuid()" }, index: {unique: true}
        t.string :name, limit: 60, null: false
        t.text :note
        t.integer :sort_order, null: false, default: 0
        t.datetime :archived_at
        t.bigint :book_id
        t.timestamps
      end
      add_index table, "user_id, lower((name)::text)", unique: true, name: "index_#{table}_on_user_and_lower_name"
    end

    create_table :finance_transaction_tags, primary_key: [:transaction_id, :tag_id] do |t|
      t.references :transaction, null: false, index: false, foreign_key: {to_table: :finance_transactions, on_delete: :cascade}
      t.references :tag, null: false, foreign_key: {to_table: :finance_tags, on_delete: :cascade}
    end

    create_table :finance_budgets do |t|
      t.references :user, null: false, foreign_key: true
      t.uuid :uuid, null: false, default: -> { "gen_random_uuid()" }, index: {unique: true}
      t.string :period, null: false, default: "month"
      t.string :category
      t.references :project, foreign_key: {to_table: :finance_projects, on_delete: :cascade}
      t.decimal :amount, precision: 15, scale: 2, null: false
      t.integer :alert_percent, null: false, default: 90
      t.bigint :book_id
      t.timestamps
      t.check_constraint "period IN ('month', 'year')", name: "finance_budgets_period"
      t.check_constraint "amount > 0", name: "finance_budgets_amount"
      t.check_constraint "alert_percent BETWEEN 1 AND 100", name: "finance_budgets_alert"
    end

    create_table :finance_recurring_rules do |t|
      t.references :user, null: false, foreign_key: true
      t.uuid :uuid, null: false, default: -> { "gen_random_uuid()" }, index: {unique: true}
      t.string :name, limit: 60, null: false
      t.jsonb :template, null: false, default: {}
      t.string :frequency, null: false
      t.integer :interval, null: false, default: 1
      t.date :start_on, null: false
      t.date :end_on
      t.date :next_on
      t.boolean :auto_post, null: false, default: false
      t.boolean :paused, null: false, default: false
      t.bigint :book_id
      t.timestamps
      t.check_constraint "frequency IN ('daily', 'weekly', 'monthly', 'yearly')", name: "finance_recurring_frequency"
      t.check_constraint "interval BETWEEN 1 AND 365", name: "finance_recurring_interval"
    end

    create_table :finance_category_settings do |t|
      t.references :user, null: false, foreign_key: true
      t.string :name, limit: 40, null: false
      t.string :parent_name, limit: 40
      t.string :category_kind, null: false, default: "expense"
      t.integer :sort_order, null: false, default: 0
      t.boolean :hidden, null: false, default: false
      t.bigint :book_id
      t.timestamps
      t.check_constraint "category_kind IN ('expense', 'income')", name: "finance_category_settings_kind"
    end
    add_index :finance_category_settings, "user_id, lower((name)::text)", unique: true, name: "index_finance_category_settings_on_user_and_lower_name"

    create_table :finance_organize_runs do |t|
      t.references :user, null: false, foreign_key: true
      t.uuid :uuid, null: false, default: -> { "gen_random_uuid()" }, index: {unique: true}
      t.string :status, null: false, default: "preview"
      t.string :engine, null: false, default: "rules"
      t.jsonb :proposals, null: false, default: []
      t.uuid :batch_id
      t.datetime :applied_at
      t.datetime :undone_at
      t.bigint :book_id
      t.timestamps
      t.check_constraint "status IN ('preview', 'applied', 'undone', 'discarded')", name: "finance_organize_runs_status"
    end

    add_foreign_key :finance_transactions, :finance_merchants, column: :merchant_id, on_delete: :nullify
    add_foreign_key :finance_transactions, :finance_projects, column: :project_id, on_delete: :nullify
    add_foreign_key :finance_transactions, :finance_recurring_rules, column: :recurring_rule_id, on_delete: :nullify
  end
end
