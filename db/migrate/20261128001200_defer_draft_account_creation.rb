class DeferDraftAccountCreation < ActiveRecord::Migration[8.1]
  def change
    add_column :finance_statement_drafts, :account_identity, :jsonb, default: {}, null: false
  end
end
