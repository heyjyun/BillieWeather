require "test_helper"

class Finance::SnapshotTest < ActiveSupport::TestCase
  setup do
    @user = create(:user)
    Finance::Profile.create!(user: @user)
    @statement = Finance::Statement.create!(user: @user, filename: "test.csv", currency: "USD", sha256: "a" * 64, transaction_count: 4)
  end

  test "sums exact amounts and excludes transfers ignored rows and other accounts" do
    transaction("0.30", "Income")
    transaction("-0.10", "Food & dining")
    transaction("-100", "Transfers")
    transaction("-200", "Housing", excluded: true)
    other = create(:user)
    other_statement = Finance::Statement.create!(user: other, filename: "other.csv", currency: "USD", sha256: "b" * 64, transaction_count: 1)
    Finance::Transaction.create!(user: other, statement: other_statement, booked_on: Date.current, description: "Another account", amount: 9999, category: "Income")

    result = Finance::Snapshot.new(user: @user).to_h
    assert_equal BigDecimal("0.30"), result[:income]
    assert_equal BigDecimal("0.10"), result[:expenses]
    assert_equal BigDecimal("0.20"), result[:net]
    assert_equal 4, result[:transaction_count]
    assert_equal [{name: "Food & dining", amount: BigDecimal("0.10")}], result[:categories]
    assert_equal BigDecimal("0.20"), result[:monthly].first[:net]
    assert result[:recent_transactions].all? { |entry| entry.user_id == @user.id }
  end

  test "new accounts return an honest empty state" do
    result = Finance::Snapshot.new(user: create(:user)).to_h
    assert_equal 0, result[:income]
    assert_equal 0, result[:transaction_count]
    assert_empty result[:categories]
    assert_empty result[:monthly]
    assert_nil result[:period_start]
  end

  private

  def transaction(amount, category, excluded: false)
    Finance::Transaction.create!(user: @user, statement: @statement, booked_on: Date.current,
      description: "Test", amount: amount, category: category, excluded: excluded)
  end
end
