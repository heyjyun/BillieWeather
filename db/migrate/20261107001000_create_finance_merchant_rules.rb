class CreateFinanceMerchantRules < ActiveRecord::Migration[8.1]
  def change
    create_table :finance_merchant_rules do |t|
      t.references :user, null: false, foreign_key: true
      t.string :merchant_key, null: false
      t.boolean :income, null: false, default: false
      t.string :category, null: false
      t.timestamps
    end
    add_index :finance_merchant_rules, [:user_id, :merchant_key, :income], unique: true, name: "index_finance_merchant_rules_on_user_merchant_direction"
  end
end
