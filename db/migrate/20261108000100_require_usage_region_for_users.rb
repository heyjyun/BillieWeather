class RequireUsageRegionForUsers < ActiveRecord::Migration[8.1]
  def up
    add_column :users, :usage_region_pending, :boolean, default: false, null: false
    # Existing regions cannot be guessed. Only these accounts may temporarily
    # remain unset, and the application requires them to complete selection.
    execute "UPDATE users SET usage_region_pending = TRUE WHERE usage_region IS NULL"
    add_check_constraint :users, "usage_region IS NOT NULL OR usage_region_pending",
      name: "users_usage_region_required"
  end

  def down
    remove_check_constraint :users, name: "users_usage_region_required"
    remove_column :users, :usage_region_pending
  end
end
