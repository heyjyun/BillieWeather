class CreateFinanceCommandExecutions < ActiveRecord::Migration[8.1]
  def change
    # One row per data-changing command run from the website's command bar (Finance::SmartCommand):
    # the idempotency key (a repeated submission replays the stored result instead of running
    # again) and, while undo is possible, the minimal previous state to restore. No transaction
    # descriptions or amounts are stored: undo data is ids, previous category/excluded values or a
    # category id and name. Rows older than a day are pruned on the person's next command.
    create_table :finance_command_executions do |t|
      t.references :user, null: false, foreign_key: true, index: false
      t.string :idempotency_key, null: false, limit: 100
      t.string :action_id, null: false, limit: 60
      t.string :request_digest, null: false, limit: 64
      t.jsonb :result, null: false, default: {}
      t.jsonb :undo_payload
      t.string :undo_token_digest, limit: 64
      t.datetime :undo_expires_at
      t.datetime :undone_at
      t.timestamps
    end
    add_index :finance_command_executions, [:user_id, :idempotency_key], unique: true, name: "index_finance_command_executions_on_user_and_key"
    add_index :finance_command_executions, :undo_token_digest, unique: true, where: "undo_token_digest IS NOT NULL"
    add_index :finance_command_executions, [:user_id, :created_at]
  end
end
