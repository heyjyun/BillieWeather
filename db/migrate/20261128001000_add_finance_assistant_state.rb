class AddFinanceAssistantState < ActiveRecord::Migration[8.1]
  def change
    add_column :finance_bank_accounts, :balance_pending, :boolean, default: false, null: false
    add_column :finance_profiles, :assistant_state, :jsonb, default: {}, null: false
  end
end
