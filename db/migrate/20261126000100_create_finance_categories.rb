# Category hierarchy (docs/architecture/category-hierarchy.md): one row per category a person owns,
# nested without limit. Names stay the identity (unique per person ignoring case); defaults carry a
# stable system_key. Uncategorized is a fixed placeholder and never a row.
#
# finance_custom_categories and finance_category_settings stay untouched (for rollback; dropped later).
# users.finance_categories_seeded_at records that a person's tree exists; the next migration fills
# it for every existing account. Rollback drops the new table and column only.
class CreateFinanceCategories < ActiveRecord::Migration[8.1]
  def change
    create_table :finance_categories do |t|
      t.references :user, null: false, foreign_key: true, index: false
      t.string :name, null: false, limit: 40
      t.bigint :parent_id
      t.string :system_key, limit: 80
      t.string :category_kind, null: false, default: "expense"
      t.integer :sort_order, null: false, default: 0
      t.boolean :hidden, null: false, default: false
      t.boolean :expanded, null: false, default: false
      t.timestamps
    end
    add_index :finance_categories, "user_id, lower((name)::text)", unique: true, name: "index_finance_categories_on_user_and_lower_name"
    add_index :finance_categories, [:user_id, :system_key], unique: true, where: "system_key IS NOT NULL", name: "index_finance_categories_on_user_and_system_key"
    add_index :finance_categories, [:id, :user_id], unique: true, name: "index_finance_categories_on_id_and_user"
    add_index :finance_categories, [:user_id, :parent_id], name: "index_finance_categories_on_user_and_parent"
    # The parent belongs to the same person (composite key), and a parent with children cannot be deleted.
    add_foreign_key :finance_categories, :finance_categories, column: [:parent_id, :user_id], primary_key: [:id, :user_id],
      on_delete: :restrict, name: "fk_finance_categories_parent_same_user"
    add_check_constraint :finance_categories, "category_kind IN ('income', 'expense', 'transfer')", name: "finance_categories_kind"
    add_check_constraint :finance_categories, "parent_id IS NULL OR parent_id <> id", name: "finance_categories_not_own_parent"

    add_column :users, :finance_categories_seeded_at, :datetime
  end
end
