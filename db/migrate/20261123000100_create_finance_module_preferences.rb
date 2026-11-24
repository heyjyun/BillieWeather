# Feature Library preferences (Settings › Feature Library, Phase 1a).
#
# Purely additive: one new table, nothing existing changes. A row is a person's explicit choice for one
# module; no row means the catalog default (packages/shared-types/schema/module-catalog.json), so no
# backfill is needed and existing accounts get the new default navigation (product decision 1).
# These are view preferences, not financial data: no foreign key from or to any finance table.
# `changed_at` + `revision` prepare the Phase 1b cross-device merge (last change wins per module);
# nothing syncs yet.
#
# Rollback drops the table: everyone returns to the defaults; no financial record is affected.
class CreateFinanceModulePreferences < ActiveRecord::Migration[8.1]
  def change
    create_table :finance_module_preferences do |t|
      t.references :user, null: false, foreign_key: {on_delete: :cascade}, index: false
      t.string :module_key, null: false, limit: 40
      t.boolean :enabled, null: false
      t.bigint :revision, null: false, default: 1
      t.datetime :changed_at, null: false
      t.timestamps
    end
    add_index :finance_module_preferences, [:user_id, :module_key], unique: true, name: "index_finance_module_preferences_one_per_module"
    add_check_constraint :finance_module_preferences, "module_key ~ '^[a-z_]{2,40}$'", name: "finance_module_preferences_key_format"
    add_check_constraint :finance_module_preferences, "revision > 0", name: "finance_module_preferences_revision"
  end
end
