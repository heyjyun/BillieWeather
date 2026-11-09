require "test_helper"

class Finance::DataDeletionTest < ActiveSupport::TestCase
  test "cached forecasts are cleared only for the deleted person" do
    cache = ActiveSupport::Cache::MemoryStore.new
    mine = ["finance/prophet/v1", 42, "2026-11-08", "a"]
    similar_id = ["finance/prophet/v1", 421, "2026-11-08", "a"]
    cache.write(mine, 1)
    cache.write(similar_id, 2)
    Finance::DataDeletion.clear_cached_forecasts(42, cache: cache)
    assert_nil cache.read(mine)
    assert_equal 2, cache.read(similar_id)
  end

  test "a cache that cannot match keys does not fail deletion" do
    assert_nil Finance::DataDeletion.clear_cached_forecasts(1, cache: ActiveSupport::Cache::NullStore.new)
  end

  test "deletes every finance table for one user and nothing else" do
    user = create(:user)
    other = create(:user)
    [user, other].each_with_index do |person, index|
      Finance::Profile.create!(user: person, currency: "USD")
      statement = Finance::Statement.create!(user: person, filename: "a.csv", currency: "USD", sha256: index.to_s * 64, transaction_count: 1)
      Finance::Transaction.create!(user: person, statement: statement, booked_on: Date.current, description: "x", amount: 1, category: "Income")
    end
    counts = Finance::DataDeletion.call(user: user)
    assert_equal 1, counts["finance_transactions"]
    assert_equal 1, counts["finance_statements"]
    assert_equal 1, counts["finance_profiles"]
    assert_equal 1, Finance::Transaction.where(user: other).count
    assert_equal 1, Finance::Profile.where(user: other).count
    assert_raises(ArgumentError) { Finance::DataDeletion.new(user: User.new) }
  end
end
