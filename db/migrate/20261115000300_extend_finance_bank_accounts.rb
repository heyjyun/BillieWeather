# Accounts of every type (cash, wallets, loans, receivables), created by hand or by import.
# Additive: account_type is backfilled from the old kind (financial-schema legacy_account_kinds.web).
class ExtendFinanceBankAccounts < ActiveRecord::Migration[8.1]
  TYPES = %w[checking savings cash payment_app investment receivable credit_card loan other].freeze

  def up
    change_table :finance_bank_accounts, bulk: true do |t|
      t.string :account_type, null: false, default: "other"
      t.string :currency, limit: 3
      t.decimal :opening_balance, precision: 15, scale: 2, null: false, default: 0
      t.date :opening_balance_on
      t.decimal :credit_limit, precision: 15, scale: 2
      t.integer :statement_day
      t.integer :due_day
      t.boolean :include_in_net_worth, null: false, default: true
      t.text :note
      t.integer :sort_order, null: false, default: 0
      t.datetime :archived_at
      t.boolean :manual, null: false, default: false
      t.uuid :uuid, null: false, default: -> { "gen_random_uuid()" }
      t.bigint :book_id
    end
    execute "UPDATE finance_bank_accounts SET account_type = CASE kind WHEN 'cash' THEN 'checking' WHEN 'credit' THEN 'credit_card' ELSE 'other' END"
    change_column_null :finance_bank_accounts, :identity_key, true
    change_column_null :finance_bank_accounts, :last4, true
    change_column_null :finance_bank_accounts, :bank_name, true
    add_check_constraint :finance_bank_accounts, "account_type IN (#{TYPES.map { |t| "'#{t}'" }.join(", ")})", name: "finance_bank_accounts_type"
    add_check_constraint :finance_bank_accounts, "statement_day IS NULL OR statement_day BETWEEN 1 AND 31", name: "finance_bank_accounts_statement_day"
    add_check_constraint :finance_bank_accounts, "due_day IS NULL OR due_day BETWEEN 1 AND 31", name: "finance_bank_accounts_due_day"
    add_check_constraint :finance_bank_accounts, "manual OR identity_key IS NOT NULL", name: "finance_bank_accounts_identity_or_manual"
    add_index :finance_bank_accounts, :uuid, unique: true
  end

  def down
    %w[finance_bank_accounts_type finance_bank_accounts_statement_day finance_bank_accounts_due_day finance_bank_accounts_identity_or_manual].each do |name|
      remove_check_constraint :finance_bank_accounts, name: name
    end
    remove_columns :finance_bank_accounts, :account_type, :currency, :opening_balance, :opening_balance_on, :credit_limit, :statement_day, :due_day,
      :include_in_net_worth, :note, :sort_order, :archived_at, :manual, :uuid, :book_id
  end
end
