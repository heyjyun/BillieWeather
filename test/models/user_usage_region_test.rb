require "test_helper"

class UserUsageRegionTest < ActiveSupport::TestCase
  test "usage region is optional for existing and Google users" do
    user = create(:user)
    google_user = create(:user, google_uid: "optional-region-google-user")

    assert_nil user.reload.usage_region
    assert_nil google_user.reload.usage_region
    assert user.valid?
    assert google_user.valid?
  end

  test "supported country codes normalize and persist while a blank choice clears the region" do
    user = create(:user, usage_region: " jp ")
    assert_equal "JP", user.reload.usage_region

    assert user.update(usage_region: "us")
    assert_equal "US", user.reload.usage_region
    assert user.update(usage_region: "  ")
    assert_nil user.reload.usage_region
  end

  test "country list includes major countries across regions and excludes arbitrary values" do
    %w[US CN JP KR GB CA AU DE FR IN SG HK TW BR MX ZA AE].each do |code|
      assert_includes UsageRegion::CODES, code
    end
    user = create(:user, usage_region: "US")
    %w[XX ZZ Atlantis USA 12].each do |value|
      user.usage_region = value
      assert_not user.valid?, "Accepted unsupported usage region #{value.inspect}"
      assert user.errors.of_kind?(:usage_region, :inclusion)
    end
    assert_equal "US", user.reload.usage_region
  end

  test "database constraint rejects unsupported codes even when application validation is bypassed" do
    user = create(:user, usage_region: "US")
    ["XX", "", "us"].each do |value|
      assert_raises(ActiveRecord::StatementInvalid) do
        User.transaction(requires_new: true) { user.update_columns(usage_region: value) }
      end
      assert_equal "US", user.reload.usage_region
    end

    assert user.update_columns(usage_region: "CA")
    assert_equal "CA", user.reload.usage_region
    assert user.update_columns(usage_region: nil)
    assert_nil user.reload.usage_region
  end
end
