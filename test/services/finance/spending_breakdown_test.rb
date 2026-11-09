require "test_helper"

class Finance::SpendingBreakdownTest < ActiveSupport::TestCase
  setup do
    @user = create(:user)
    Finance::Profile.create!(user: @user)
    @statement = Finance::Statement.create!(user: @user, filename: "test.csv", currency: "USD", sha256: "c" * 64, transaction_count: 1)
    @breakdown = Finance::SpendingBreakdown.new(user: @user)
  end

  test "the biggest spending categories own a color in every period; the rest are Other" do
    names = ["Housing", "Food & dining", "Transport", "Utilities", "Shopping", "Health", "Business"]
    names.each_with_index { |name, index| spend((800 - index * 100).to_s, name, "2026-01-10") }
    @user.finance_custom_categories.create!(name: "Pets")
    spend("5", "Pets", "2026-02-10")
    spend("50", "Uncategorized", "2026-02-11")
    spend("999", "Transfers", "2026-02-12")
    spend("999", "Housing", "2026-02-12", excluded: true)
    transaction("2000", "Income", "2026-02-01")

    assert_equal names, @breakdown.palette
    assert_equal 0, @breakdown.tone("Housing")
    assert_equal "other", @breakdown.tone("Pets")
    assert_equal "uncategorized", @breakdown.tone("Uncategorized")

    february = @breakdown.mix(start_date: Date.new(2026, 2, 1), end_date: Date.new(2026, 2, 28))
    assert_equal BigDecimal("55"), february[:total]
    assert_equal [Finance::SpendingBreakdown::OTHER, "Uncategorized"], february[:parts].map { |part| part[:key] }
    assert_equal ["Pets"], february[:parts].first[:members]
    assert_in_delta 5 / 55.0, february[:parts].first[:share]

    all = @breakdown.mix
    assert_equal names + [Finance::SpendingBreakdown::OTHER, "Uncategorized"], all[:parts].map { |part| part[:key] }
    assert_in_delta 1.0, all[:parts].sum { |part| part[:share] }
  end

  test "months are consecutive, end at the latest month, and stack in one order" do
    spend("10", "Food & dining", "2026-01-05")
    spend("40", "Housing", "2026-01-06")
    spend("20", "Food & dining", "2026-03-05")

    months = @breakdown.monthly(months: 3)
    assert_equal [Date.new(2026, 1, 1), Date.new(2026, 2, 1), Date.new(2026, 3, 1)], months.map { |month| month[:month] }
    assert_equal ["Housing", "Food & dining"], months.first[:segments].map { |segment| segment[:key] }
    assert_equal BigDecimal("50"), months.first[:total]
    assert_empty months.second[:segments]
    assert_equal BigDecimal("20"), months.last[:total]
  end

  test "a category trend averages from its first month and lists its biggest merchants" do
    spend("10", "Food & dining", "2026-01-05", "STARBUCKS STORE 1234")
    spend("30", "Food & dining", "2026-03-06", "Starbucks Store 99")
    spend("20", "Food & dining", "2026-03-07", "CHIPOTLE 0042")
    spend("5", "Housing", "2025-06-01")

    trend = @breakdown.trend("Food & dining", months: 12)
    assert_equal 12, trend[:months].size
    assert_equal Date.new(2026, 3, 1), trend[:latest][:month]
    assert_equal BigDecimal("50"), trend[:latest][:amount]
    # January, February (nothing) and March: 60 / 3.
    assert_equal BigDecimal("20"), trend[:average]

    merchants = @breakdown.top_merchants("Food & dining")
    assert_equal [{name: "Starbucks Store", amount: BigDecimal("40"), count: 2}, {name: "Chipotle", amount: BigDecimal("20"), count: 1}], merchants
  end

  test "no transactions means empty charts" do
    assert_empty @breakdown.palette
    assert_equal({total: 0, parts: []}, @breakdown.mix)
    assert_empty @breakdown.monthly
    assert_nil @breakdown.trend("Housing")[:average]
  end

  private

  def spend(amount, category, date, description = "#{category} purchase", excluded: false)
    transaction("-#{amount}", category, date, description, excluded: excluded)
  end

  def transaction(amount, category, date, description = "#{category} item", excluded: false)
    Finance::Transaction.create!(user: @user, statement: @statement, booked_on: Date.iso8601(date), description: description, amount: amount, category: category, excluded: excluded)
  end
end
