class CreateFinanceCustomCategories < ActiveRecord::Migration[8.1]
  def change
    # Categories a person adds on top of the built-in list (Finance::Transaction::CATEGORIES).
    # Transactions and remembered rules keep storing the category name as text, as before.
    create_table :finance_custom_categories do |t|
      t.references :user, null: false, foreign_key: true
      t.string :name, null: false, limit: 40
      t.timestamps
    end
    add_index :finance_custom_categories, "user_id, lower(name)", unique: true, name: "index_finance_custom_categories_on_user_and_lower_name"

    # When this person last ran "Categorize with AI" (website or app), for a short per-user cooldown.
    # On users rather than finance_profiles so the apps never create a profile (which fixes the currency).
    add_column :users, :finance_ai_categorized_at, :datetime
  end
end
