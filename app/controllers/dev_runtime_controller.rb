require "digest"

class DevRuntimeController < ActionController::Base
  def show
    return head :not_found unless Rails.env.development? && request.local?

    pool = ActiveRecord::Base.connection_pool
    schema = pool.migration_context
    pending = schema.pending_migration_versions
    version = schema.current_version
    expected = schema.migrations.map(&:version).max || 0
    missing_tables = pool.with_connection do |connection|
      %w[users finance_transactions finance_categories finance_module_preferences finance_sidebar_orders].reject do |table|
        connection.table_exists?(table)
      end
    end
    catalog = Finance::ModuleCatalog::SCHEMA
    ready = pending.empty? && missing_tables.empty? && version == expected
    response.headers["Cache-Control"] = "no-store"
    render json: {
      ready: ready,
      schema: {version: version, expected: expected, pending: pending, missing_tables: missing_tables},
      catalog: {version: catalog.fetch("version"), digest: Digest::SHA256.hexdigest(JSON.generate(catalog))},
      module_sync: {enabled: Finance::ModulePreferenceSync.enabled?, format: Finance::ModulePreferenceSync::FORMAT}
    }, status: ready ? :ok : :service_unavailable
  end
end
