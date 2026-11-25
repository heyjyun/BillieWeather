require_relative "../billie_database_target"
require_relative "../billie_runtime_settings"

namespace :billie do
  namespace :release do
    desc "Verify the release database and schema using the runtime role"
    task check: :environment do
      abort "Use RAILS_ENV=production for release startup" unless Rails.env.production?
      # A local rehearsal has no public address; its database rules are checked below.
      BillieRuntimeSettings.verify! unless ENV["BILLIE_DB_ENV"] == "local" && ENV["RENDER"] != "true"
      target = BillieDatabaseTarget.release_url!(ENV.fetch("DATABASE_URL"), migration: false)
      ActiveRecord::Base.with_connection do |connection|
        BillieDatabaseTarget.verify!(connection, target, migration: false)
        ActiveRecord::Migration.check_all_pending!
      end
      puts "Rails database target and migration history verified."
    end

    desc "Apply Rails migrations to the explicitly approved direct database target"
    task :migrate do
      abort "Use RAILS_ENV=production for release migrations" unless Rails.env.production?
      abort "Set BILLIE_RELEASE_APPROVAL to the approved change reference" if ENV["BILLIE_RELEASE_APPROVAL"].to_s.strip.empty?
      url = ENV.fetch("DATABASE_URL_UNPOOLED") { abort "A direct migration URL is required" }
      target = BillieDatabaseTarget.release_url!(url, migration: true)
      ENV["DATABASE_URL"] = url
      Rake::Task["environment"].invoke
      ActiveRecord::Base.with_connection do |connection|
        BillieDatabaseTarget.verify!(connection, target, migration: true)
        # The release must target an existing application database, with its historical
        # migration state. Never initialize an empty production DB from a schema dump.
        abort "Missing Rails migration history" unless connection.table_exists?(:schema_migrations)
        pool = ActiveRecord::Base.connection_pool
        pool.migration_context.migrate
        pool.schema_cache.clear!
      end
    end
  end
end

task :protect_production_database do
  abort "Use the approved release migration task for production schema changes" if Rails.env.production?
end

%w[db:version db:migrate:status db:abort_if_pending_migrations].tap do |read_only|
  Rake::Task.tasks.each do |task|
    if task.name.start_with?("db:") && !read_only.include?(task.name)
      task.prerequisites.unshift("protect_production_database")
    end
  end
end
