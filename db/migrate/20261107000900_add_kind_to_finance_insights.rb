class AddKindToFinanceInsights < ActiveRecord::Migration[8.1]
  def change
    add_column :finance_insights, :kind, :string, null: false, default: "general"
    add_index :finance_insights, [:user_id, :kind, :generated_at]
  end
end
