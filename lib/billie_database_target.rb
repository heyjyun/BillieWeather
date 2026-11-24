# frozen_string_literal: true

require "pg"

module BillieDatabaseTarget
  LOCAL_HOSTS = ["localhost", "127.0.0.1", "::1"].freeze
  URL_OPTIONS = %w[host port dbname user password sslmode sslrootcert channel_binding connect_timeout].freeze
  OVERRIDES = %w[PGSERVICE PGSERVICEFILE PGHOSTADDR PGOPTIONS].freeze

  def self.local_host?(host)
    host.to_s.empty? || LOCAL_HOSTS.include?(host) || (host.start_with?("/") && !host.include?(","))
  end

  def self.reject_overrides!
    if OVERRIDES.any? { |key| !ENV[key].to_s.empty? }
      raise "Unsafe libpq environment override"
    end
  end

  def self.options(url)
    unless url.start_with?("postgresql://", "postgres://")
      raise "Expected a PostgreSQL connection URL"
    end

    options = PG::Connection.conninfo_parse(url).to_h { |entry| [entry[:keyword], entry[:val]] }.compact
    raise "Unexpected option in PostgreSQL connection URL" unless (options.keys - URL_OPTIONS).empty?

    options
  rescue PG::Error
    raise "Invalid PostgreSQL connection URL", cause: nil
  end

  def self.local!(environment)
    reject_overrides!
    if !ENV["BILLIE_DB_ENV"].to_s.empty? && ENV["BILLIE_DB_ENV"] != "local"
      raise "Development and tests require a local database"
    end

    url = ENV["PRIMARY_DATABASE_URL"] || ENV["DATABASE_URL"]
    target = url ? options(url) : {}
    hosts = [target["host"], ENV["PGHOST"], ENV["DATABASE_HOST"]]
    name = target["dbname"]
    suffix = (environment == "test") ? /_(?:test|compat)(?:\d+|_[a-zA-Z0-9_]+)?\z/ : /_development\z/
    unless hosts.all? { |host| local_host?(host) } && (!url || name&.match?(suffix))
      raise "Refusing a non-local or incorrectly named #{environment} database"
    end
  end

  def self.release_url!(url, migration:)
    reject_overrides!
    target = options(url)
    environment = ENV.fetch("BILLIE_DB_ENV", "")
    pinned_host = ENV.fetch("BILLIE_DB_HOST", "")
    name = ENV.fetch("BILLIE_DB_NAME", "")
    identity = ENV.fetch("BILLIE_DB_TARGET_ID", "")
    target_host = target["host"]
    expected_neon = pinned_host.match?(/\Aep-[a-z0-9-]+\.[a-z0-9.-]+\.neon\.tech\z/) && !pinned_host.split(".").first.end_with?("-pooler")
    allowed = case environment
    when "production", "staging"
      pooled_host = pinned_host.sub(".", "-pooler.")
      expected_neon && target["sslmode"] == "verify-full" &&
        (target_host == pinned_host || (!migration && target_host == pooled_host))
    when "local"
      ENV["RENDER"] != "true" && !pinned_host.empty? && local_host?(pinned_host) && target_host == pinned_host
    end
    if !allowed || name.empty? || target["dbname"] != name || target["user"].to_s.empty? ||
        !identity.match?(/\A[a-zA-Z0-9_-]{12,128}\z/)
      raise "PostgreSQL URL does not match the approved database target"
    end
    target
  end

  def self.verify!(connection, target, migration:)
    actual = connection.select_one(<<~SQL)
      SELECT current_database() AS database_name, current_user AS database_role,
             current_setting('billie.target_id', true) AS target_id,
             current_setting('billie.environment', true) AS environment
    SQL
    unless actual.values_at("database_name", "database_role", "target_id", "environment") ==
        [target.fetch("dbname"), target.fetch("user"), ENV.fetch("BILLIE_DB_TARGET_ID"), ENV.fetch("BILLIE_DB_ENV")]
      raise "Connected PostgreSQL server did not confirm the approved database target"
    end
    return if migration

    # A runtime account must be unable to create schemas, modify application schemas or assume
    # an owning/privileged role. PostgreSQL 14 may grant CREATE on public to PUBLIC by default.
    writable_schema = connection.select_value(<<~SQL)
      SELECT has_database_privilege(current_database(), 'CREATE')
        OR EXISTS (
          SELECT 1 FROM pg_roles r
          WHERE (r.rolsuper OR r.rolcreaterole OR r.rolcreatedb OR r.rolreplication OR r.rolbypassrls)
            AND pg_has_role(current_user, r.oid, 'MEMBER')
        )
        OR EXISTS (
          SELECT 1 FROM pg_namespace n WHERE n.nspname IN ('public', 'identity')
            AND (has_schema_privilege(n.oid, 'CREATE') OR pg_has_role(current_user, n.nspowner, 'MEMBER'))
        )
        OR EXISTS (
          SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname IN ('public', 'identity') AND pg_has_role(current_user, c.relowner, 'MEMBER')
        )
    SQL
    raise "Runtime database role has schema privileges" if writable_schema
  end
end
