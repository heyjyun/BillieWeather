require "test_helper"
require Rails.root.join("lib/billie_runtime_settings").to_s

class BillieRuntimeSettingsTest < ActiveSupport::TestCase
  KEY = "k" * 64
  GOOD = {"BILLIE_SECRET_KEY_BASE" => KEY, "BASE_URL" => "https://finance.example", "REDIS_URL" => "redis://cache",
          "POSTMARK_API_TOKEN" => "synthetic", "MAIL_FROM" => "noreply@finance.example"}.freeze

  def errors(changes = {}) = BillieRuntimeSettings.review(GOOD.merge(changes))[:errors]
  def warnings(changes = {}) = BillieRuntimeSettings.review(GOOD.merge(changes))[:warnings]

  test "a complete environment has nothing to report" do
    assert_equal({errors: [], warnings: []}, BillieRuntimeSettings.review(GOOD))
  end

  test "the rollback fence is reported open while an older release could read the same key" do
    assert_match(/rollback fence open/, warnings("SECRET_KEY_BASE" => KEY).join)
    assert_match(/rollback fence open/, warnings("BILLIE_SECRET_KEY_BASE" => nil, "SECRET_KEY_BASE" => KEY).join)
    assert_empty warnings("SECRET_KEY_BASE" => "z" * 64)
  end

  test "missing, short or build-only settings stop the server without printing values" do
    assert_match(/is missing/, errors("BILLIE_SECRET_KEY_BASE" => nil).join)
    assert_match(/at least 64/, errors("BILLIE_SECRET_KEY_BASE" => "private-value").join)
    assert_match(/builds only/, errors("SECRET_KEY_BASE_DUMMY" => "1").join)
    ["http://finance.example", "", "https://", "not a url"].each { |url| assert_match(/https/, errors("BASE_URL" => url).join) }
    assert_empty errors("BASE_URL" => "", "RENDER_EXTERNAL_URL" => "https://finance.onrender.com")
    assert_match(/GOOGLE_CLIENT_SECRET is missing/, errors("GOOGLE_CLIENT_ID" => "synthetic").join)
    assert_match(/MAIL_FROM is missing/, errors("MAIL_FROM" => " ").join)
    error = assert_raises(RuntimeError) { BillieRuntimeSettings.verify!(GOOD.merge("BILLIE_SECRET_KEY_BASE" => "private-value")) }
    assert_not_includes error.message, "private-value"
  end

  test "degraded but safe settings only warn" do
    assert_match(/REDIS_URL/, warnings("REDIS_URL" => nil).join)
    assert_match(/no email delivery/, warnings("POSTMARK_API_TOKEN" => nil, "MAIL_FROM" => nil).join)
  end

  test "the application signs with BILLIE_SECRET_KEY_BASE when it is set" do
    assert_includes Rails.root.join("config/application.rb").read, 'config.secret_key_base = ENV["BILLIE_SECRET_KEY_BASE"]'
    blueprint = YAML.safe_load_file(Rails.root.join("render.yaml"))
    keys = blueprint.fetch("envVarGroups").flat_map { |group| group.fetch("envVars").map { |entry| entry["key"] } }
    assert_includes keys, BillieRuntimeSettings::KEY
    assert_not_includes keys, BillieRuntimeSettings::LEGACY_KEY
  end
end
