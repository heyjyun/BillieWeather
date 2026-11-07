class CreateFinanceInsights < ActiveRecord::Migration[8.1]
  def change
    create_table :finance_insights do |t|
      t.references :user, null: false, foreign_key: true
      t.string :source, null: false
      t.jsonb :content, null: false, default: {}
      t.datetime :generated_at, null: false
      t.timestamps
    end

    add_index :finance_insights, [:user_id, :generated_at]
  end
end
