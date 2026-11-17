# Finance schema integrity (docs/audits/claude-fable-5-2-follow-up-2026-11-16.md, sections D-F).
#
# Until now "this row belongs to the same person as the row it points at" was checked only by model
# validations, which bulk writes (insert_all!, update_all, update_columns) skip. This migration moves
# that rule into the database: every reference between finance tables carries the owner, so a row can
# never point at another person's statement, account, entry, merchant, project, rule or tag.
#
# It also removes structures nothing reads or writes (they only suggested guarantees that did not
# exist) and replaces indexes that duplicated the leading column of another index.
#
# Data: no financial value is changed. Columns dropped here were never populated by the application
# (`book_id` on eleven tables, `finance_transactions.fingerprint`) or held one constant
# (`finance_statements.status`). Adding a constraint fails, without changing anything, if existing
# rows violate it: that is the intended signal to inspect those rows before going further.
class EnforceFinanceIntegrity < ActiveRecord::Migration[8.1]
  # Tables other finance rows point at: a UNIQUE (id, user_id) lets a child reference "this row of this person".
  OWNED_PARENTS = %i[finance_statements finance_bank_accounts finance_transactions finance_merchants finance_projects finance_recurring_rules finance_tags].freeze

  # [child, parent, column, on_delete, replaces the single-column foreign key?]
  # A reference that is nulled when its parent goes (merchant, project, recurring rule) keeps its
  # single-column key for that action: SET NULL on a composite key would also null user_id.
  OWNER_KEYS = [
    [:finance_transactions, :finance_statements, :statement_id, nil, true],
    [:finance_transactions, :finance_bank_accounts, :bank_account_id, nil, true],
    [:finance_transactions, :finance_merchants, :merchant_id, nil, false],
    [:finance_transactions, :finance_projects, :project_id, nil, false],
    [:finance_transactions, :finance_recurring_rules, :recurring_rule_id, nil, false],
    [:finance_statements, :finance_bank_accounts, :bank_account_id, nil, true],
    [:finance_statement_drafts, :finance_bank_accounts, :bank_account_id, nil, true],
    [:finance_transaction_links, :finance_transactions, :from_transaction_id, :cascade, true],
    [:finance_transaction_links, :finance_transactions, :to_transaction_id, :cascade, true],
    [:finance_budgets, :finance_projects, :project_id, :cascade, true],
    [:finance_transaction_tags, :finance_transactions, :transaction_id, :cascade, true],
    [:finance_transaction_tags, :finance_tags, :tag_id, :cascade, true]
  ].freeze

  UNUSED_BOOK_ID = %i[finance_transactions finance_bank_accounts finance_audit_events finance_budgets finance_category_settings finance_merchants
    finance_organize_runs finance_projects finance_recurring_rules finance_tags finance_transaction_links].freeze

  # Single-column user_id indexes whose job another index starting with user_id already does.
  REDUNDANT_USER_INDEXES = %i[finance_transactions finance_statements finance_bank_accounts finance_audit_events finance_insights finance_merchant_rules
    finance_custom_categories finance_category_settings finance_merchants finance_projects finance_tags finance_local_devices finance_local_database_reports].freeze

  CHECKS = {
    finance_transactions: {
      "finance_transactions_category_present" => "category <> ''",
      "finance_transactions_category_source" => "category_source IN ('user', 'rule', 'file', 'auto', 'region', 'ai', 'legacy')",
      "finance_transactions_amount_range" => "amount > -10000000000000 AND amount < 10000000000000",
      "finance_transactions_locked_fields_array" => "jsonb_typeof(user_locked_fields) = 'array'",
      "finance_transactions_original_present" => "original_description <> ''"
    },
    finance_transaction_links: {
      "finance_links_two_entries" => "to_transaction_id IS NULL OR to_transaction_id <> from_transaction_id",
      "finance_links_amount" => "amount IS NULL OR amount >= 0"
    },
    finance_statements: {
      "finance_statements_rows" => "transaction_count > 0",
      "finance_statements_sha256" => "sha256 ~ '^[0-9a-f]{64}$'"
    }
  }.freeze

  def up
    # Tags of an entry: the join row now names its owner, like every other finance row.
    add_column :finance_transaction_tags, :user_id, :bigint
    execute "UPDATE finance_transaction_tags SET user_id = t.user_id FROM finance_transactions t WHERE t.id = finance_transaction_tags.transaction_id"
    change_column_null :finance_transaction_tags, :user_id, false
    add_foreign_key :finance_transaction_tags, :users

    OWNED_PARENTS.each { |table| add_index table, [:id, :user_id], unique: true, name: "index_#{table}_on_id_and_owner" }
    OWNER_KEYS.each do |child, parent, column, on_delete, replaces|
      remove_foreign_key child, parent, column: column if replaces
      add_foreign_key child, parent, column: [column, :user_id], primary_key: [:id, :user_id], on_delete: on_delete, name: owner_key_name(child, column)
    end

    CHECKS.each { |table, checks| checks.each { |name, expression| add_check_constraint table, expression, name: name } }

    UNUSED_BOOK_ID.each { |table| remove_column table, :book_id }
    remove_index :finance_transactions, name: "index_finance_transactions_on_fingerprint"
    remove_column :finance_transactions, :fingerprint
    remove_column :finance_statements, :status

    REDUNDANT_USER_INDEXES.each { |table| remove_index table, name: "index_#{table}_on_user_id" }
    # Deleting or merging a merchant/project/recurring rule looks its entries up by these columns;
    # without an index each of those is a scan of every entry of every person.
    add_index :finance_transactions, :merchant_id, where: "merchant_id IS NOT NULL", name: "index_finance_transactions_on_merchant"
    add_index :finance_transactions, :project_id, where: "project_id IS NOT NULL", name: "index_finance_transactions_on_project"
    # The trash holds few rows; indexing only those keeps the index tiny and every insert cheaper.
    remove_index :finance_transactions, name: "index_finance_transactions_on_user_id_and_deleted_at"
    add_index :finance_transactions, [:user_id, :deleted_at], where: "deleted_at IS NOT NULL", name: "index_finance_transactions_on_trash"
    # The ledger pages list a person's live entries newest first.
    remove_index :finance_transactions, name: "index_finance_transactions_on_user_id_and_booked_on"
    add_index :finance_transactions, [:user_id, :booked_on, :id], order: {booked_on: :desc, id: :desc}, where: "deleted_at IS NULL", name: "index_finance_transactions_on_live_recent"
    add_index :finance_transaction_tags, [:user_id, :tag_id], name: "index_finance_transaction_tags_on_owner_tag"
  end

  def down
    remove_index :finance_transaction_tags, name: "index_finance_transaction_tags_on_owner_tag"
    remove_index :finance_transactions, name: "index_finance_transactions_on_live_recent"
    add_index :finance_transactions, [:user_id, :booked_on]
    remove_index :finance_transactions, name: "index_finance_transactions_on_trash"
    add_index :finance_transactions, [:user_id, :deleted_at]
    remove_index :finance_transactions, name: "index_finance_transactions_on_project"
    remove_index :finance_transactions, name: "index_finance_transactions_on_merchant"
    REDUNDANT_USER_INDEXES.each { |table| add_index table, :user_id, name: "index_#{table}_on_user_id" }

    add_column :finance_statements, :status, :string, null: false, default: "imported"
    add_column :finance_transactions, :fingerprint, :string
    add_index :finance_transactions, :fingerprint
    UNUSED_BOOK_ID.each { |table| add_column table, :book_id, :bigint }

    CHECKS.each { |table, checks| checks.each_key { |name| remove_check_constraint table, name: name } }

    OWNER_KEYS.reverse_each do |child, parent, column, on_delete, replaces|
      remove_foreign_key child, name: owner_key_name(child, column)
      add_foreign_key child, parent, column: column, on_delete: on_delete if replaces
    end
    OWNED_PARENTS.each { |table| remove_index table, name: "index_#{table}_on_id_and_owner" }

    remove_foreign_key :finance_transaction_tags, :users
    remove_column :finance_transaction_tags, :user_id
  end

  private

  def owner_key_name(child, column)
    "fk_#{child.to_s.delete_prefix("finance_")}_#{column.to_s.delete_suffix("_id")}_owner"
  end
end
