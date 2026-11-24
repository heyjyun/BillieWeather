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

  private

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
