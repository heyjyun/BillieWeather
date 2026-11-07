class CreateFinanceWorkspace < ActiveRecord::Migration[8.1]
  def change
    create_table :finance_profiles do |t|
      t.references :user, null: false, foreign_key: true, index: {unique: true}
      t.string :currency, null: false, default: "USD"
      t.decimal :current_balance, precision: 15, scale: 2, null: false, default: 0
      t.string :tax_country
      t.string :tax_profile
      t.timestamps
    end

    create_table :finance_statements do |t|
      t.references :user, null: false, foreign_key: true
      t.string :filename, null: false
      t.string :currency, null: false
      t.string :sha256, null: false
      t.string :status, null: false, default: "imported"
      t.integer :transaction_count, null: false, default: 0
      t.timestamps
    end
    add_index :finance_statements, [:user_id, :sha256], unique: true

    create_table :finance_transactions do |t|
      t.references :user, null: false, foreign_key: true
      t.references :statement, null: false, foreign_key: {to_table: :finance_statements}
      t.date :booked_on, null: false
      t.string :description, limit: 500, null: false
      t.decimal :amount, precision: 15, scale: 2, null: false
      t.string :category, null: false, default: "Uncategorized"
      t.boolean :tax_review, null: false, default: false
      t.boolean :excluded, null: false, default: false
      t.timestamps
    end
    add_index :finance_transactions, [:user_id, :booked_on]
  end
end
