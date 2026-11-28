class PreservePersonalizedSidebarVisibility < ActiveRecord::Migration[8.1]
  def up
    execute <<~SQL
      WITH prior(module_key) AS (VALUES ('overview'), ('accounts'), ('categories'))
      INSERT INTO finance_module_preferences
        (user_id, module_key, enabled, revision, changed_at, created_at, updated_at)
      SELECT personalized.user_id, prior.module_key, TRUE, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
      FROM (
        SELECT user_id FROM finance_module_preferences
        UNION
        SELECT user_id FROM finance_sidebar_orders WHERE module_keys <> '[]'
      ) AS personalized
      CROSS JOIN prior
      WHERE TRUE
      ON CONFLICT (user_id, module_key) DO NOTHING
    SQL
  end

  # The previous client understands these explicit choices. Keep any subsequent user edits.
  def down
  end
end
