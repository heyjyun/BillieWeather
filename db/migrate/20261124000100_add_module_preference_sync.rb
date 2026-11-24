class AddModulePreferenceSync < ActiveRecord::Migration[8.1]
  def change
    add_column :finance_module_preferences, :updated_by_device_id, :uuid

    create_table :finance_module_preference_mutations do |t|
      t.references :user, null: false, foreign_key: {on_delete: :cascade}, index: false
      t.uuid :mutation_id, null: false
      t.uuid :device_id, null: false
      t.string :request_hash, null: false, limit: 64
      t.jsonb :result, null: false
      t.datetime :created_at, null: false
      t.index [:user_id, :mutation_id], unique: true, name: "index_finance_module_preference_mutations_on_user_and_id"
    end
  end
end
