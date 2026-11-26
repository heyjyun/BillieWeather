# New subcategories the AI suggested during "Categorize with AI" on the website
# (docs/architecture/category-hierarchy.md, AI). Never created automatically: the Categories page
# shows pending ones with Approve and Dismiss. `payload` holds the transaction ids and the cleaned
# merchant texts of the groups the proposal fits (no amounts or dates).
class CreateFinanceCategoryProposals < ActiveRecord::Migration[8.1]
  def change
    create_table :finance_category_proposals do |t|
      t.references :user, null: false, foreign_key: {on_delete: :cascade}, index: false
      t.string :parent_name, null: false, limit: 40
      t.string :name, null: false, limit: 40
      t.jsonb :payload, null: false, default: {}
      t.string :status, null: false, default: "pending", limit: 20
      t.timestamps
    end
    add_index :finance_category_proposals, [:user_id, :status], name: "index_finance_category_proposals_on_user_and_status"
    add_check_constraint :finance_category_proposals, "status IN ('pending', 'approved', 'dismissed')", name: "finance_category_proposals_status"
  end
end
