require "test_helper"

class Finance::CategorizerTest < ActiveSupport::TestCase
  setup do
    @user = create(:user)
    @other = create(:user)
    @categorizer = Finance::Categorizer.new(user: @user)
  end

  def categorize(description, amount, categorizer = @categorizer)
    categorizer.categorize(description, BigDecimal(amount.to_s))
  end

  test "built-in merchants and keywords" do
    assert_equal "Food & dining", categorize("UBER EATS ORDER 8841", -22)
    assert_equal "Transport", categorize("UBER TRIP HELP.UBER.COM", -18)
    assert_equal "Uncategorized", categorize("AMAZON WEB SERVICES AWS.AMAZON", -41)
    assert_equal "Shopping", categorize("AMAZON MKTPLACE PMTS", -19)
    assert_equal "Utilities", categorize("COMCAST CABLE", -80)
    assert_equal "Health", categorize("CVS/PHARMACY #1234", -12)
    assert_equal "Housing", categorize("Rent payment", -1400)
  end

  test "positive amounts are income, transfers are detected, unknown merchants stay uncategorized" do
    assert_equal "Income", categorize("ACME PAYROLL", 3000)
    assert_equal "Transfers", categorize("Transfer to savings", -500)
    assert_equal "Uncategorized", categorize("ZXQ WIDGETS LLC", -20)
  end

  # Same cases as packages/finance-core/test/core.test.ts ("card payments printed with punctuation").
  test "card payments printed with punctuation are transfers, not income" do
    assert_equal "Transfers", categorize("AUTOPAY PAYMENT - THANK YOU", 500)
    assert_equal "Transfers", categorize("ONLINE PAYMENT, THANK YOU", 500)
    assert_equal "Transfers", categorize("CREDIT-CARD PAYMENT", -500)
    assert_equal "Income", categorize("PAYMENT THANK YOURSELF SPA", 50)
    assert_equal "Utilities", categorize("COMCAST AUTOPAY", -80)
  end

  test "a person-to-person payment is not hidden as a transfer" do
    assert_equal "Uncategorized", categorize("Zelle payment to Sam", -60)
  end

  test "merchant keys ignore store numbers, places and bank noise" do
    assert_equal Finance::Categorizer.merchant_key("STARBUCKS STORE #1234 SEATTLE WA"), Finance::Categorizer.merchant_key("Starbucks Store 99 Portland OR")
    assert_equal "zxq widgets", Finance::Categorizer.merchant_key("POS PURCHASE ZXQ WIDGETS LLC 4455")
    assert_nil Finance::Categorizer.merchant_key("12345 #99")
    assert_nil Finance::Categorizer.merchant_key("")
    assert Finance::Categorizer.merchant_key("星巴克 咖啡")
  end

  test "a remembered merchant overrides the built-in lists, per direction and per account" do
    Finance::MerchantRule.create!(user: @user, merchant_key: "zxq widgets", income: false, category: "Health")
    Finance::MerchantRule.create!(user: @user, merchant_key: "uber trip", income: false, category: "Business")
    fresh = Finance::Categorizer.new(user: @user)
    assert_equal "Health", categorize("ZXQ WIDGETS 998", -5, fresh)
    assert_equal "Business", categorize("UBER TRIP HELP.UBER.COM", -18, fresh)
    assert_equal "Income", categorize("ZXQ WIDGETS REFUND", 5, fresh)
    other = Finance::Categorizer.new(user: @other)
    assert_equal "Uncategorized", categorize("ZXQ WIDGETS 998", -5, other)
    assert_equal "Transport", categorize("UBER TRIP HELP.UBER.COM", -18, other)
  end

  test "remember! updates only this account's Uncategorized rows from the same merchant and direction" do
    statement = statement_for(@user)
    same = transaction_for(@user, statement, "ZXQ WIDGETS 111", -10)
    same_again = transaction_for(@user, statement, "Zxq Widgets store 22", -12)
    refund = transaction_for(@user, statement, "ZXQ WIDGETS REFUND", 4, "Income")
    chosen = transaction_for(@user, statement, "ZXQ WIDGETS 333", -9, "Shopping")
    different = transaction_for(@user, statement, "OTHER SHOP", -7)
    others = transaction_for(@other, statement_for(@other), "ZXQ WIDGETS 444", -8)

    updated = Finance::MerchantRule.remember!(user: @user, description: "ZXQ WIDGETS 111", amount: -10, category: "Business")

    assert_equal 2, updated
    assert_equal "Business", same.reload.category
    assert same.tax_review
    assert_equal "Business", same_again.reload.category
    assert_equal "Income", refund.reload.category
    assert_equal "Shopping", chosen.reload.category
    assert_equal "Uncategorized", different.reload.category
    assert_equal "Uncategorized", others.reload.category
    assert_equal 1, Finance::MerchantRule.where(user: @user).count
  end

  test "remember! keeps one rule per merchant and direction and ignores unusable input" do
    Finance::MerchantRule.remember!(user: @user, description: "ZXQ WIDGETS 111", amount: -10, category: "Business")
    Finance::MerchantRule.remember!(user: @user, description: "ZXQ WIDGETS 222", amount: -10, category: "Health")
    assert_equal ["Health"], Finance::MerchantRule.where(user: @user, merchant_key: "zxq widgets").pluck(:category)
    assert_nil Finance::MerchantRule.remember!(user: @user, description: "12345", amount: -1, category: "Health")
    assert_nil Finance::MerchantRule.remember!(user: @user, description: "ZXQ WIDGETS", amount: -1, category: "Uncategorized")
  end

  test "recategorize_uncategorized! applies current rules and never changes a chosen category" do
    statement = statement_for(@user)
    now_known = transaction_for(@user, statement, "UBER TRIP 1", -9)
    still_unknown = transaction_for(@user, statement, "ZXQ WIDGETS", -9)
    chosen = transaction_for(@user, statement, "UBER TRIP 2", -9, "Shopping")

    assert_equal 1, Finance::Categorizer.recategorize_uncategorized!(user: @user)
    assert_equal "Transport", now_known.reload.category
    assert_equal "Uncategorized", still_unknown.reload.category
    assert_equal "Shopping", chosen.reload.category
  end

  private

  def statement_for(user)
    Finance::Statement.create!(user: user, filename: "s.csv", currency: "USD", sha256: SecureRandom.hex(32), status: "imported", transaction_count: 1)
  end

  def transaction_for(user, statement, description, amount, category = "Uncategorized")
    Finance::Transaction.create!(user: user, statement: statement, booked_on: Date.current, description: description, amount: amount, category: category)
  end
end
