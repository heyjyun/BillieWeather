# frozen_string_literal: true

# With BILLIE_DB_ENV=development, config/database.yml has already pinned the Neon development branch
# (BillieDatabaseTarget.development_target!). Here every new connection must also prove, from data on
# the server, that it reached that branch: billie_release.target says 'development' with the configured
# BILLIE_DB_TARGET_ID. Production has no such row, so a misrouted connection is closed before use.
if Rails.env.development? && ENV["BILLIE_DB_ENV"] == "development"
  require Rails.root.join("lib/billie_database_target").to_s

  ActiveSupport.on_load(:active_record_postgresqladapter) do
    prepend(Module.new do
      private

      def configure_connection
        BillieDatabaseTarget.verify_development_connection!(@raw_connection)
        super
      end
    end)
  end
end
