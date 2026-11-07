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

  test "date bounds scope every aggregate and recent transaction including their endpoints" do
    @profile = Finance::Profile.find_by!(user: @user)
    @profile.update!(current_balance: "2500.00")
    dated_transaction("2025-12-31", "900", "Income")
    dated_transaction("2026-01-01", "100.10", "Income")
    dated_transaction("2026-01-15", "-20.05", "Food & dining", tax_review: true)
    dated_transaction("2026-01-31", "-5.00", "Uncategorized")
    dated_transaction("2026-01-20", "-30.00", "Transfers")
    dated_transaction("2026-01-21", "-40.00", "Housing", excluded: true)
    dated_transaction("2026-02-01", "800", "Income")

    result = Finance::Snapshot.new(user: @user, start_date: Date.new(2026, 1, 1), end_date: Date.new(2026, 1, 31)).to_h
    assert_equal BigDecimal("100.10"), result[:income]
    assert_equal BigDecimal("25.05"), result[:expenses]
    assert_equal BigDecimal("75.05"), result[:net]
    assert_equal BigDecimal("2500.00"), result[:current_balance]
    assert_equal 5, result[:transaction_count]
    assert_equal 1, result[:statement_count]
    assert_equal 1, result[:uncategorized_count]
    assert_equal 1, result[:tax_review_count]
    assert_equal 1, result[:transfer_count]
    assert_equal 1, result[:excluded_count]
    assert_equal [Date.new(2026, 1, 1)], result[:monthly].map { |month| month[:month] }
    assert_equal Date.new(2026, 1, 1), result[:period_start]
    assert_equal Date.new(2026, 1, 31), result[:period_end]
    assert result[:recent_transactions].all? { |transaction| transaction.booked_on.between?(Date.new(2026, 1, 1), Date.new(2026, 1, 31)) }

    empty = Finance::Snapshot.new(user: @user, start_date: Date.new(2027, 1, 1), end_date: Date.new(2027, 1, 31)).to_h
    assert_equal 0, empty[:transaction_count]
    assert_equal 0, empty[:statement_count]
    assert_equal BigDecimal("2500.00"), empty[:current_balance]
    assert_empty empty[:monthly]
    assert_empty empty[:recent_transactions]
  end

  private

  def dated_transaction(date, amount, category, **attributes)
    Finance::Transaction.create!(user: @user, statement: @statement, booked_on: Date.iso8601(date),
      description: "Dated test", amount: amount, category: category, **attributes)
  end

  def transaction(amount, category, excluded: false)
    Finance::Transaction.create!(user: @user, statement: @statement, booked_on: Date.current,
      description: "Test", amount: amount, category: category, excluded: excluded)
  end
end
