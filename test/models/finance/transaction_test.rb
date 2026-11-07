require "test_helper"

class Finance::TransactionTest < ActiveSupport::TestCase
  test "transaction ownership cannot cross account boundaries" do
    owner = create(:user)
    stranger = create(:user)
    statement = Finance::Statement.create!(user: owner, filename: "test.csv", currency: "USD", sha256: "a" * 64, transaction_count: 1)
    transaction = Finance::Transaction.new(user: stranger, statement: statement, booked_on: Date.current,
      description: "Mismatched ownership", amount: -1, category: "Uncategorized")
    refute transaction.valid?
    assert_includes transaction.errors[:statement], "must belong to the same account"
  end

  test "account currency cannot be changed without removing existing statements" do
    user = create(:user)
    profile = Finance::Profile.create!(user: user, currency: "USD")
    Finance::Statement.create!(user: user, filename: "test.csv", currency: "USD", sha256: "a" * 64, transaction_count: 1)
    refute profile.update(currency: "CAD")
    assert_includes profile.errors[:currency], "cannot change while statements in another currency exist"
  end

  test "balances cannot silently round fractional cents" do
    profile = Finance::Profile.new(user: create(:user), current_balance: "12.345")
    refute profile.valid?
    assert_includes profile.errors[:current_balance], "must have at most two decimal places"
  end
end
