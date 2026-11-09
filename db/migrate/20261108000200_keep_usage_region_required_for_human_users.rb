class KeepUsageRegionRequiredForHumanUsers < ActiveRecord::Migration[8.1]
  def up
    remove_check_constraint :users, name: "users_usage_region_required"
    add_check_constraint :users,
      "usage_region IS NOT NULL OR usage_region_pending OR platform_agent_of_id IS NOT NULL",
      name: "users_usage_region_required"
    # OAuth service principals share the users table but are not human signups.
    execute "UPDATE users SET usage_region_pending = FALSE WHERE platform_agent_of_id IS NOT NULL"
  end

  def down
    execute "UPDATE users SET usage_region_pending = TRUE WHERE platform_agent_of_id IS NOT NULL AND usage_region IS NULL"
    remove_check_constraint :users, name: "users_usage_region_required"
    add_check_constraint :users, "usage_region IS NOT NULL OR usage_region_pending",
      name: "users_usage_region_required"
  end
end
