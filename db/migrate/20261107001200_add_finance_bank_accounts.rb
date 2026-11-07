class AddFinanceBankAccounts < ActiveRecord::Migration[8.1]
  def change
    create_table :finance_bank_accounts do |t|
      t.references :user, null: false, foreign_key: true
      t.string :identity_key, null: false
      t.string :bank_name, null: false
      t.string :name, null: false
      t.string :last4, null: false
      t.string :kind, null: false, default: "unknown"
      t.timestamps
    end
    add_index :finance_bank_accounts, [:user_id, :identity_key], unique: true
    add_reference :finance_statements, :bank_account, foreign_key: {to_table: :finance_bank_accounts}
    add_reference :finance_statement_drafts, :bank_account, foreign_key: {to_table: :finance_bank_accounts}
    add_column :finance_statements, :balance_observed_on, :date
    add_column :finance_statement_drafts, :balance_observed_on, :date

    reversible do |dir|
      dir.up do
        execute <<~SQL
          UPDATE finance_statements SET balance_observed_on = GREATEST(closing_balance_on,
            (SELECT MAX(booked_on) FROM finance_transactions WHERE statement_id = finance_statements.id))
        SQL
      end
    end
  end
end
