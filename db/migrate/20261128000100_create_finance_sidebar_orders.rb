# One saved sidebar order per account (Settings › Sidebar customization): the module ids in the order
# the person arranged their sidebar. Navigation only, like finance_module_preferences: it never
# decides whether a module works. Absent means catalog order. Additive; no existing row changes.
class CreateFinanceSidebarOrders < ActiveRecord::Migration[8.1]
  def change
    create_table :finance_sidebar_orders do |t|
      t.references :user, null: false, foreign_key: {on_delete: :cascade}, index: {unique: true}
      t.jsonb :module_keys, null: false, default: []
      t.bigint :revision, null: false, default: 1
      t.datetime :changed_at, null: false
      t.uuid :updated_by_device_id
      t.timestamps
      t.check_constraint "jsonb_typeof(module_keys) = 'array'", name: "finance_sidebar_orders_keys_array"
      t.check_constraint "revision > 0", name: "finance_sidebar_orders_revision"
    end
  end
end
