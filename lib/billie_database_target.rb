# frozen_string_literal: true

require "pg"

module BillieDatabaseTarget
  LOCAL_HOSTS = ["localhost", "127.0.0.1", "::1"].freeze
  URL_OPTIONS = %w[host port dbname user password sslmode sslrootcert channel_binding connect_timeout].freeze
  OVERRIDES = %w[PGSERVICE PGSERVICEFILE PGHOSTADDR PGOPTIONS].freeze
  REMOTE_HOST = /\A(?=.{1,253}\z)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]*\z/
  NEON_HOST = /\Aep-[a-z0-9-]+\.[a-z0-9.-]+\.neon\.tech\z/
  # Neon endpoints of the production branch. Development and tests refuse them (direct or -pooler)
  # whatever else is configured. BILLIE_PRODUCTION_DB_ENDPOINTS (comma-separated) can add more.
  PRODUCTION_ENDPOINTS = %w[ep-raspy-sound-bdlg3br7].freeze
  DEVELOPMENT_URLS = %w[DATABASE_URL DATABASE_URL_UNPOOLED].freeze

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

  def self.endpoint_id(host)
    host.to_s.split(".").first.to_s.delete_suffix("-pooler")
  end

  def self.production_endpoints
    PRODUCTION_ENDPOINTS + ENV.fetch("BILLIE_PRODUCTION_DB_ENDPOINTS", "").split(",").map(&:strip).reject(&:empty?)
  end

  def self.refuse_production!(hosts)
    denied = production_endpoints
    if hosts.compact.flat_map { |host| host.split(",") }.any? { |host| denied.include?(endpoint_id(host)) }
      raise "Refusing the production database outside production"
    end
  end

  def self.local!(environment)
    reject_overrides!
    urls = (["PRIMARY_DATABASE_URL"] + DEVELOPMENT_URLS).filter_map { |key| ENV[key] unless ENV[key].to_s.empty? }
    refuse_production!(urls.map { |url| options(url)["host"] } + [ENV["PGHOST"], ENV["DATABASE_HOST"], ENV["BILLIE_DB_HOST"]])
    return development_target! if environment == "development" && ENV["BILLIE_DB_ENV"] == "development"

    if !ENV["BILLIE_DB_ENV"].to_s.empty? && ENV["BILLIE_DB_ENV"] != "local"
      raise "Development and tests require a local database"
    end

    url = ENV["PRIMARY_DATABASE_URL"] || ENV["DATABASE_URL"]
    target = url ? options(url) : {}
    hosts = [target["host"], ENV["PGHOST"], ENV["DATABASE_HOST"]]
    name = target["dbname"]
    suffix = (environment == "test") ? /_(?:test|compat)(?:\d+|_[a-zA-Z0-9_]+)?\z/ : /_development\z/
    allowed = hosts.all? { |host| local_host?(host) } && (!url || name&.match?(suffix))
    unless allowed
      raise "Refusing a non-local or incorrectly named #{environment} database"
    end
    nil
  end

  # Development may use a dedicated Neon development branch instead of a local server, pinned the same
  # way as a release target. Every connection then has to confirm the branch's billie_release.target
  # marker (environment 'development'), see verify_development_connection!.
  def self.development_target!
    pinned_host = ENV.fetch("BILLIE_DB_HOST", "")
    name = ENV.fetch("BILLIE_DB_NAME", "")
    identity = ENV.fetch("BILLIE_DB_TARGET_ID", "")
    endpoint, suffix = pinned_host.split(".", 2)
    problems = []
    problems << "BILLIE_DB_HOST must be the direct Neon endpoint hostname (without -pooler)" unless pinned_host.match?(NEON_HOST) && !endpoint.end_with?("-pooler")
    problems << "BILLIE_DB_TARGET_ID must be 12-128 letters, digits, _ or -" unless identity.match?(/\A[a-zA-Z0-9_-]{12,128}\z/)
    problems << "BILLIE_DB_NAME is missing" if name.empty?
    problems << "PRIMARY_DATABASE_URL must not be set" unless ENV["PRIMARY_DATABASE_URL"].to_s.empty?
    problems << "DATABASE_URL is missing" if ENV["DATABASE_URL"].to_s.empty?
    DEVELOPMENT_URLS.each do |key|
      next if ENV[key].to_s.empty?
      target = options(ENV[key])
      problems << "#{key} host must be BILLIE_DB_HOST or its -pooler form" unless [pinned_host, "#{endpoint}-pooler.#{suffix}"].include?(target["host"])
      problems << "#{key} must set sslmode=verify-full" unless target["sslmode"] == "verify-full"
      problems << "#{key} database must equal BILLIE_DB_NAME" unless target["dbname"] == name
      problems << "#{key} has no user" if target["user"].to_s.empty?
    end
    raise "Development database does not match the approved development target: #{problems.join("; ")}" if problems.any?
    {"environment" => "development", "target_id" => identity}
  end

  # Runs on the raw PG::Connection right after Rails connects, before any application query.
  def self.verify_development_connection!(raw_connection)
    row = begin
      raw_connection.exec("SELECT environment, target_id FROM billie_release.target WHERE singleton").first
    rescue PG::Error
      nil
    end
    unless row && row["environment"] == "development" && row["target_id"] == ENV.fetch("BILLIE_DB_TARGET_ID")
      raw_connection.close
      raise "Connected PostgreSQL server did not confirm the approved development database"
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
    provider = ENV.fetch("BILLIE_DB_PROVIDER", "neon")
    expected_neon = pinned_host.match?(NEON_HOST) && !pinned_host.split(".").first.end_with?("-pooler")
    # Each failed condition is named (never a value), so a refused start says what to fix.
    problems = []
    case environment
    when "production", "staging"
      pooled_host = pinned_host.sub(".", "-pooler.")
      case provider
      when "neon"
        problems << "BILLIE_DB_HOST must be the direct Neon endpoint hostname (without -pooler)" unless expected_neon
      when "postgres"
        problems << "BILLIE_DB_HOST must be a remote PostgreSQL DNS name" unless pinned_host.match?(REMOTE_HOST) && !pinned_host.end_with?(".localhost")
      else
        problems << "BILLIE_DB_PROVIDER must be neon or postgres"
      end
      problems << "the URL must set sslmode=verify-full" unless target["sslmode"] == "verify-full"
      if target_host != pinned_host && (provider != "neon" || migration || target_host != pooled_host)
        problems << ((migration || provider != "neon") ? "the URL host must equal BILLIE_DB_HOST" : "the URL host must be BILLIE_DB_HOST or its -pooler form")
      end
    when "local"
      problems << "BILLIE_DB_ENV=local is refused on Render" if ENV["RENDER"] == "true"
      if pinned_host.empty? || !local_host?(pinned_host) || target_host != pinned_host
        problems << "BILLIE_DB_HOST must be a local host equal to the URL host"
      end
    else
      problems << "BILLIE_DB_ENV must be production, staging or local"
    end
    if name.empty?
      problems << "BILLIE_DB_NAME is missing"
    elsif target["dbname"] != name
      problems << "the URL database must equal BILLIE_DB_NAME"
    end
    problems << "the URL has no user" if target["user"].to_s.empty?
    problems << "BILLIE_DB_TARGET_ID must be 12-128 letters, digits, _ or -" unless identity.match?(/\A[a-zA-Z0-9_-]{12,128}\z/)
    raise "PostgreSQL URL does not match the approved database target: #{problems.join("; ")}" if problems.any?
    target
  end

  def self.verify!(connection, target, migration:)
    actual = connection.select_one(<<~SQL)
      SELECT current_database() AS database_name, current_user AS database_role,
             target_id, environment
      FROM billie_release.target
      WHERE singleton
    SQL
    unless actual&.values_at("database_name", "database_role", "target_id", "environment") ==
        [target.fetch("dbname"), target.fetch("user"), ENV.fetch("BILLIE_DB_TARGET_ID"), ENV.fetch("BILLIE_DB_ENV")]
      raise "Connected PostgreSQL server did not confirm the approved database target"
    end
    return if migration

    # A runtime account must be unable to create schemas, modify application schemas or assume
    # an owning/privileged role. PostgreSQL 14 may grant CREATE on public to PUBLIC by default.
    writable_schema = connection.select_value(<<~SQL)
      SELECT has_database_privilege(current_database(), 'CREATE')
        OR has_table_privilege('billie_release.target', 'INSERT, UPDATE, DELETE, TRUNCATE, TRIGGER')
        OR has_any_column_privilege('billie_release.target', 'INSERT, UPDATE')
        OR EXISTS (
          SELECT 1 FROM pg_roles r
          WHERE (r.rolsuper OR r.rolcreaterole OR r.rolcreatedb OR r.rolreplication OR r.rolbypassrls)
            AND pg_has_role(current_user, r.oid, 'MEMBER')
        )
        OR EXISTS (
          SELECT 1 FROM pg_namespace n WHERE n.nspname IN ('public', 'identity', 'billie_release')
            AND (has_schema_privilege(n.oid, 'CREATE') OR pg_has_role(current_user, n.nspowner, 'MEMBER'))
        )
        OR EXISTS (
          SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname IN ('public', 'identity', 'billie_release') AND pg_has_role(current_user, c.relowner, 'MEMBER')
        )
    SQL
    raise "Runtime database role has schema or target-marker write privileges" if writable_schema
  end
end
