class CreateFinanceStatementDrafts < ActiveRecord::Migration[8.1]
  def change
    create_table :finance_statement_drafts do |t|
      t.references :user, null: false, foreign_key: true
      t.string :filename, null: false
      t.string :sha256, null: false
      t.string :currency, null: false
      t.jsonb :rows, null: false, default: []
      t.jsonb :warnings, null: false, default: []
      t.datetime :expires_at, null: false
      t.timestamps
    end
    add_index :finance_statement_drafts, :expires_at

    change_column_default :finance_profiles, :tax_country, from: nil, to: "United States"
    change_column_default :finance_profiles, :tax_profile, from: nil, to: "personal"
    reversible do |direction|
      direction.up do
        execute "UPDATE finance_profiles SET tax_country = 'United States' WHERE tax_country IS NULL OR tax_country = ''"
        execute "UPDATE finance_profiles SET tax_profile = 'personal' WHERE tax_profile IS NULL OR tax_profile = ''"
      end
    end
  end
end
