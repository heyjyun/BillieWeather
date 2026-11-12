require "test_helper"
require "digest"

class DemoAccountSeederTest < ActiveSupport::TestCase
  setup do
    @today = Date.new(2026, 11, 11)
    @personal = create(:onboarded_user, email: "owner@example.com")
    statement = Finance::Statement.create!(user: @personal, filename: "mine.csv", currency: "USD",
      sha256: Digest::SHA256.hexdigest("mine"), transaction_count: 1)
    @personal_transaction = Finance::Transaction.create!(user: @personal, statement: statement,
      booked_on: @today - 2, description: "MY OWN COFFEE", amount: -4.5, category: "Food & dining")
  end

  test "creates one demo account with synthetic statements, corrections, insights and forecasts" do
    demo = DemoAccount::Seeder.call(today: @today)

    assert demo.demo_account?
    assert_equal DemoAccount::EMAIL, demo.email
    assert_not demo.developer?
    assert_not demo.valid_password?("")
    assert demo.current_team.present?

    assert_equal 3, demo.finance_bank_accounts.count
    assert_equal %w[cash cash credit], demo.finance_bank_accounts.order(:kind).pluck(:kind)
    assert_operator demo.finance_statements.count, :>=, 15
    assert_operator demo.finance_transactions.count, :>=, 120
    categories = demo.finance_transactions.distinct.pluck(:category)
    %w[Income Housing Transfers Business Pets Travel Uncategorized].each { |category| assert_includes categories, category }
    assert demo.finance_transactions.where(tax_review: true).exists?
    assert demo.finance_transactions.where("description LIKE ?", "%EUR%").exists?
    assert demo.finance_transactions.where("description LIKE ?", "%JPY%").exists?
    assert_equal 4, demo.finance_merchant_rules.count
    assert_equal %w[Pets Travel], demo.finance_custom_categories.order(:name).pluck(:name)
    assert_equal %w[general tax], demo.finance_insights.order(:kind).pluck(:kind)

    # Transfers balance out: money out of checking arrives in savings and on the card.
    transfers = demo.finance_transactions.where(category: "Transfers")
    assert_equal 0, transfers.sum(:amount)

    summary = Finance::BalanceSync.summary(user: demo)
    assert summary[:complete]
    assert summary[:total].positive?
    assert summary[:credit_total].positive?

    travel do
      [30, 60, 90].each do |days|
        forecast = Finance::CashFlowForecast.new(user: demo, days: days, engine: "linear").to_h
        assert forecast[:balance_available], "#{days}-day forecast has a balance"
      end
    end
  end

  test "reseeding resets the demo in place and never touches other accounts" do
    demo = DemoAccount::Seeder.call(today: @today)
    demo.finance_transactions.first.update!(category: "Health")
    personal_before = @personal_transaction.reload.attributes

    assert_no_difference ["User.count", "Team.count"] do
      again = DemoAccount::Seeder.call(today: @today)
      assert_equal demo.id, again.id
    end

    assert_equal personal_before, @personal_transaction.reload.attributes
    assert_equal 1, @personal.finance_transactions.count
    assert_equal 1, @personal.finance_statements.count
    assert_not demo.finance_transactions.where(description: "MY OWN COFFEE").exists?
    assert_equal "Income", demo.finance_transactions.find_by(description: "ACME ANALYTICS PAYROLL DIRECT DEP").category
  end

  test "the same day always produces the same synthetic data" do
    first = DemoAccount::Seeder.call(today: @today).finance_transactions.order(:booked_on, :description, :amount).pluck(:booked_on, :description, :amount)
    second = DemoAccount::Seeder.call(today: @today).finance_transactions.order(:booked_on, :description, :amount).pluck(:booked_on, :description, :amount)
    assert_equal first, second
  end

  private

  def travel(&block)
    travel_to(@today.in_time_zone("America/Chicago").change(hour: 12), &block)
  end
end
