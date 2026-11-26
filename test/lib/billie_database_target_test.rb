require "test_helper"
require Rails.root.join("lib/billie_database_target").to_s

class BillieDatabaseTargetTest < ActiveSupport::TestCase
  ENDPOINT = "ep-synthetic.us-east-2.aws.neon.tech"
  DIRECT = "postgresql://release@#{ENDPOINT}/finance?sslmode=verify-full"
  POOLED = DIRECT.sub("ep-synthetic.", "ep-synthetic-pooler.")

  test "local commands refuse Neon URLs and libpq routing overrides" do
    with_database_env("DATABASE_URL" => DIRECT) do
      assert_raises(RuntimeError) { BillieDatabaseTarget.local!("development") }
    end
    with_database_env("DATABASE_URL" => "postgresql://localhost/finance_test", "PGHOSTADDR" => "192.0.2.4") do
      assert_raises(RuntimeError) { BillieDatabaseTarget.local!("test") }
    end
  end

  DEV_HOST = "ep-devsynthetic.us-east-2.aws.neon.tech"
  DEV_DIRECT = "postgresql://dev@#{DEV_HOST}/neondb?sslmode=verify-full"
  DEV_POOLED = DEV_DIRECT.sub("ep-devsynthetic.", "ep-devsynthetic-pooler.")
  PROD_HOST = "#{BillieDatabaseTarget::PRODUCTION_ENDPOINTS.first}.c-8.us-east-2.aws.neon.tech"

  test "development may use the pinned Neon development branch, pooled and direct" do
    with_development_target("DATABASE_URL" => DEV_POOLED, "DATABASE_URL_UNPOOLED" => DEV_DIRECT) do
      assert_equal({"environment" => "development", "target_id" => "synthetic_dev_target"}, BillieDatabaseTarget.local!("development"))
    end
  end

  test "development refuses a different host, a weaker sslmode or another database" do
    [DEV_POOLED.sub("ep-devsynthetic", "ep-other"), DEV_POOLED.sub("verify-full", "require"),
      DEV_POOLED.sub("/neondb", "/other")].each do |url|
      with_development_target("DATABASE_URL" => url) do
        error = assert_raises(RuntimeError) { BillieDatabaseTarget.local!("development") }
        assert_match "does not match the approved development target", error.message
      end
    end
    with_development_target("DATABASE_URL" => DEV_POOLED, "BILLIE_DB_HOST" => DEV_HOST.sub("ep-devsynthetic", "ep-devsynthetic-pooler")) do
      assert_raises(RuntimeError) { BillieDatabaseTarget.local!("development") }
    end
  end

  test "development and tests refuse the production endpoint whatever else is set" do
    prod = "postgresql://owner@#{PROD_HOST}/neondb?sslmode=verify-full"
    [{"DATABASE_URL" => prod}, {"DATABASE_URL" => prod.sub(".c-8", "-pooler.c-8")},
      {"DATABASE_URL" => DEV_POOLED, "DATABASE_URL_UNPOOLED" => prod},
      {"DATABASE_URL" => prod.sub(PROD_HOST, "localhost/x_development?host=#{PROD_HOST}").sub("/neondb?sslmode=verify-full", "")},
      {"BILLIE_DB_HOST" => PROD_HOST, "DATABASE_URL" => prod},
      {"DATABASE_URL" => DEV_POOLED, "BILLIE_PRODUCTION_DB_ENDPOINTS" => "ep-devsynthetic"}].each do |overrides|
      with_development_target(overrides) do
        %w[development test].each do |environment|
          error = assert_raises(RuntimeError) { BillieDatabaseTarget.local!(environment) }
          assert_match(/production database|non-local|development target|Invalid/, error.message)
        end
      end
    end
  end

  test "tests never accept the development branch" do
    with_development_target("DATABASE_URL" => DEV_POOLED) do
      assert_raises(RuntimeError) { BillieDatabaseTarget.local!("test") }
    end
  end

  test "a development connection must find the development marker" do
    config = ActiveRecord::Base.connection_db_config.configuration_hash
    params = {dbname: config[:database], host: config[:host], port: config[:port], user: config[:username], password: config[:password]}.compact
    ActiveRecord::Base.with_connection do |connection|
      connection.execute("CREATE SCHEMA billie_release")
      connection.execute("CREATE TABLE billie_release.target (singleton boolean, target_id text, environment text)")
      connection.execute("INSERT INTO billie_release.target VALUES (true, 'synthetic_dev_target', 'development')")
      connection.commit_db_transaction
      begin
        with_development_target do
          raw = PG.connect(**params)
          assert_nothing_raised { BillieDatabaseTarget.verify_development_connection!(raw) }
          raw.exec("UPDATE billie_release.target SET environment = 'production'")
          error = assert_raises(RuntimeError) { BillieDatabaseTarget.verify_development_connection!(raw) }
          assert_match "did not confirm the approved development database", error.message
          assert raw.finished?
          raw = PG.connect(**params)
          raw.exec("DROP SCHEMA billie_release CASCADE")
          assert_raises(RuntimeError) { BillieDatabaseTarget.verify_development_connection!(raw) }
        end
      ensure
        connection.execute("DROP SCHEMA IF EXISTS billie_release CASCADE")
        connection.begin_db_transaction
      end
    end
  end

  test "runtime may use the approved pooler while migrations require the direct host" do
    with_release_target do
      assert_equal ENDPOINT, BillieDatabaseTarget.release_url!(DIRECT, migration: true).fetch("host")
      assert_includes BillieDatabaseTarget.release_url!(POOLED, migration: false).fetch("host"), "-pooler."
      assert_raises(RuntimeError) { BillieDatabaseTarget.release_url!(POOLED, migration: true) }
    end
  end

  test "release rejects a different branch, an unverified certificate or a connection override" do
    with_release_target do
      [DIRECT.sub("ep-synthetic", "ep-other"), DIRECT.sub("verify-full", "require"),
        DIRECT + "&hostaddr=192.0.2.4", DIRECT + "&options=-c%20billie.target_id%3Dsynthetic"].each do |url|
        assert_raises(RuntimeError) { BillieDatabaseTarget.release_url!(url, migration: true) }
      end
    end
  end

  test "a refused release target names what is wrong without printing values" do
    url = "postgresql://runtime@ep-synthetic-pooler.us-east-2.aws.neon.tech/finance?sslmode=require"
    with_database_env("BILLIE_DB_ENV" => nil, "BILLIE_DB_HOST" => nil, "BILLIE_DB_NAME" => nil, "BILLIE_DB_TARGET_ID" => nil) do
      error = assert_raises(RuntimeError) { BillieDatabaseTarget.release_url!(url, migration: false) }
      assert_match "does not match the approved database target", error.message
      ["BILLIE_DB_ENV must be", "BILLIE_DB_NAME is missing", "BILLIE_DB_TARGET_ID must be"].each { |text| assert_includes error.message, text }
      ["ep-synthetic", "finance", "runtime"].each { |value| refute_includes error.message, value }
    end
    with_release_target do
      error = assert_raises(RuntimeError) { BillieDatabaseTarget.release_url!(url, migration: false) }
      assert_includes error.message, "sslmode=verify-full"
      refute_includes error.message, "BILLIE_DB_NAME"
      error = assert_raises(RuntimeError) { BillieDatabaseTarget.release_url!(POOLED, migration: true) }
      assert_includes error.message, "the URL host must equal BILLIE_DB_HOST"
    end
  end

  test "release verifies a database-owned marker instead of a session setting" do
    ActiveRecord::Base.with_connection do |connection|
      connection.execute("CREATE SCHEMA billie_release")
      connection.execute("CREATE TABLE billie_release.target (singleton boolean, target_id text, environment text)")
      connection.execute("INSERT INTO billie_release.target VALUES (true, 'synthetic_target_51', 'staging')")
      target = {"dbname" => connection.select_value("SELECT current_database()"), "user" => connection.select_value("SELECT current_user")}
      with_release_target do
        assert_nothing_raised { BillieDatabaseTarget.verify!(connection, target, migration: true) }
        connection.execute("UPDATE billie_release.target SET target_id = 'wrong_target_51'")
        connection.execute("SET LOCAL billie.target_id = 'synthetic_target_51'")
        error = assert_raises(RuntimeError) { BillieDatabaseTarget.verify!(connection, target, migration: true) }
        assert_match "did not confirm the approved database target", error.message
      end
    end
  end

  private

  def with_development_target(overrides = {}, &block)
    with_database_env({"BILLIE_DB_ENV" => "development", "BILLIE_DB_HOST" => DEV_HOST, "BILLIE_DB_NAME" => "neondb",
                       "BILLIE_DB_TARGET_ID" => "synthetic_dev_target", "DATABASE_URL" => nil, "DATABASE_URL_UNPOOLED" => nil,
                       "PRIMARY_DATABASE_URL" => nil, "BILLIE_PRODUCTION_DB_ENDPOINTS" => nil}.merge(overrides), &block)
  end

  def with_release_target(&block)
    with_database_env("BILLIE_DB_ENV" => "staging", "BILLIE_DB_HOST" => ENDPOINT, "BILLIE_DB_NAME" => "finance",
      "BILLIE_DB_TARGET_ID" => "synthetic_target_51", &block)
  end

  def with_database_env(overrides)
    previous = ENV.to_h
    ENV.update(overrides)
    yield
  ensure
    ENV.replace(previous)
  end
end
