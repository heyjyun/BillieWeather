require "test_helper"

class UserUsageRegionTest < ActiveSupport::TestCase
  test "new users must select a region rather than saving an empty value" do
    [nil, "", "  "].each do |value|
      user = build(:user, usage_region: value)
      assert_not user.valid?
      assert user.errors.of_kind?(:usage_region, :blank)
    end
    google_user = build(:user, google_uid: "required-region-google-user", usage_region: nil)
    assert_not google_user.valid?
    assert google_user.errors.of_kind?(:usage_region, :blank)
  end

  test "supported region codes normalize and persist but cannot be cleared" do
    user = create(:user, usage_region: " jp ")
    assert_equal "JP", user.reload.usage_region

    assert user.update(usage_region: "us")
    assert_equal "US", user.reload.usage_region
    [nil, "", "  "].each do |value|
      assert_not user.update(usage_region: value)
      assert user.errors.of_kind?(:usage_region, :blank)
      assert_equal "US", user.reload.usage_region
    end
  end

  test "Global Citizen is an explicit supported region and satisfies required selection" do
    user = create(:user, usage_region: " xg ")
    assert_equal "XG", user.reload.usage_region
    assert_not user.needs_usage_region?
    assert_not user.usage_region_pending?
    assert user.update_columns(usage_region: "US")
    assert user.update_columns(usage_region: "XG")
    assert_equal "XG", user.reload.usage_region
  end

  test "region list includes major regions and excludes arbitrary values" do
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

  test "legacy users can save unrelated details while waiting to choose their region" do
    user = create(:user)
    user.update_columns(usage_region: nil, usage_region_pending: true)
    user.reload

    assert user.update(first_name: "Alex")
    assert_nil user.reload.usage_region
    assert user.usage_region_pending?
    assert_not user.update(usage_region: nil)
    assert user.errors.of_kind?(:usage_region, :blank)
    user.reload
    assert_not user.update(usage_region: "")
    assert user.errors.of_kind?(:usage_region, :blank)
    user.reload
    assert user.update(usage_region: "CN")
    assert_equal "CN", user.reload.usage_region
    assert_not user.usage_region_pending?
  end

  test "database constraints reject empty new records and unsupported codes without application validation" do
    assert_raises(ActiveRecord::StatementInvalid) do
      User.transaction(requires_new: true) do
        User.insert_all!([{email: "missing-region-db@example.com", created_at: Time.current, updated_at: Time.current}])
      end
    end

    user = create(:user, usage_region: "US")
    [nil, "XX", "", "us"].each do |value|
      assert_raises(ActiveRecord::StatementInvalid) do
        User.transaction(requires_new: true) { user.update_columns(usage_region: value) }
      end
      assert_equal "US", user.reload.usage_region
    end
    assert user.update_columns(usage_region: "CA")
    assert_equal "CA", user.reload.usage_region
  end
end
