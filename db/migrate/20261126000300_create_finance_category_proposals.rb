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
    # status IN ('pending', 'approved', 'dismissed'), written as PostgreSQL dumps it after a schema load, so a migrated
    # database and a freshly loaded one produce the same db/schema.rb (bin/db_schema_check).
    add_check_constraint :finance_category_proposals, "status::text = ANY (ARRAY['pending'::character varying::text, 'approved'::character varying::text, 'dismissed'::character varying::text])", name: "finance_category_proposals_status"
  end
end
