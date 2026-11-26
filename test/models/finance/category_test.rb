require "test_helper"

# The category hierarchy (docs/architecture/category-hierarchy.md): seeding, the old accounts'
# materialization, "Add suggested categories", unlimited depth, moves, renames, deletes, merges,
# the Transfers rules, key resolution and roll-ups.
class Finance::CategoryTest < ActiveSupport::TestCase
  setup do
    @user = create(:onboarded_user, usage_region: "US")
    @account = Finance::BankAccount.create!(user: @user, identity_key: "c" * 64, bank_name: "Synthetic Bank", name: "Checking", last4: "1234", kind: "cash")
  end

  def category(name) = Finance::Category.for_user(@user).find_by!(name: name)

  def tree = Finance::CategoryTree.new(@user.reload)

  def entry(category, amount: "-10.00", description: "Shop", kind: nil)
    Finance::Transaction.create!(user: @user, bank_account: @account, entry_origin: "manual", kind: kind || (amount.to_d.negative? ? "expense" : "income"),
      amount: amount, booked_on: Date.new(2026, 10, 5), description: description, category: category, category_source: "user")
  end

  test "a new person gets the default taxonomy once, the first time categories are read" do
    assert_nil @user.reload.finance_categories_seeded_at
    assert_equal 0, Finance::Category.where(user_id: @user.id).count
    current = tree
    assert_equal 14, current.roots.length
    assert_equal 70, current.nodes.count { |node| node.parent }
    assert_equal 84, Finance::Category.where(user_id: @user.id).count
    assert @user.reload.finance_categories_seeded_at
    assert_equal "food", category("Food & dining").system_key
    assert_equal "food.groceries", category("Groceries").system_key
    assert_equal "Food & dining", category("Groceries").parent.name
    assert_equal "transfer", category("Credit card payment").category_kind
    assert_equal "income", category("Salary").category_kind

    # Idempotent: reading again adds nothing.
    Finance::Category.ensure_seeded!(@user.reload)
    tree
    assert_equal 84, Finance::Category.where(user_id: @user.id).count

    # Deleting everything does not bring the defaults back.
    Finance::Category.delete_all_for(@user.id)
    assert_equal [Finance::Category::UNCATEGORIZED], tree.names
    assert_equal 0, Finance::Category.where(user_id: @user.id).count
  end

  test "the migration keeps an existing account's categories exactly and adds nothing new" do
    require Rails.root.join("db/migrate/20261126000200_materialize_finance_categories.rb").to_s
    legacy = create(:onboarded_user, usage_region: "US")
    Finance::CustomCategory.create!(user: legacy, name: "Pets")
    Finance::CustomCategory.create!(user: legacy, name: "Vet bills")
    Finance::CustomCategory.create!(user: legacy, name: "Bonus pay")
    Finance::CustomCategory.create!(user: legacy, name: "Orphan")
    Finance::CategorySetting.create!(user: legacy, name: "Vet bills", parent_name: "Pets", category_kind: "expense")
    Finance::CategorySetting.create!(user: legacy, name: "Bonus pay", parent_name: "Income", category_kind: "income", sort_order: 2)
    Finance::CategorySetting.create!(user: legacy, name: "Orphan", parent_name: "Gone", category_kind: "expense", hidden: true)
    Finance::CategorySetting.create!(user: legacy, name: "Housing", category_kind: "expense", hidden: true, sort_order: -1)

    migration = MaterializeFinanceCategories.new
    migration.verbose = false
    migration.migrate(:up)

    assert legacy.reload.finance_categories_seeded_at
    rows = Finance::Category.where(user_id: legacy.id)
    assert_equal 13, rows.count # nine old built-ins + four of their own, nothing from the new taxonomy
    current = Finance::CategoryTree.new(legacy)
    assert_equal %w[business food health housing income shopping transfers transport utilities].sort, rows.where.not(system_key: nil).pluck(:system_key).sort
    assert_equal "Pets", current.parent_of("Vet bills")
    assert_equal "Income", current.parent_of("Bonus pay")
    assert_equal "income", current.kind_of("Bonus pay")
    assert_nil current.parent_of("Orphan") # its old parent is missing: a root
    assert current.hidden?("Orphan")
    assert current.hidden?("Housing")
    assert_equal "Housing", current.roots.first.name # sort -1 comes first
    assert_equal "transfer", current.kind_of("Transfers")
    refute current.include?("Groceries")
    # Not seeded with the defaults later.
    assert_equal 13, Finance::Category.for_user(legacy).count
  end

  test "Add suggested categories adds only what is missing, matching keys first and then names ignoring case" do
    tree
    Finance::Category.delete_all_for(@user.id)
    Finance::Category.create_for!(@user, name: "Food & dining")
    Finance::Category.create_for!(@user, name: "groceries", parent: "Food & dining")
    Finance::Category.create_for!(@user, name: "My pets")
    category("Food & dining").update!(system_key: "food")
    renamed = Finance::Category.create_for!(@user, name: "Earnings", kind: "income")
    renamed.update!(system_key: "income")

    added = Finance::Category.add_suggested!(@user)
    current = tree
    refute_includes added, "Groceries"
    refute_includes added, "Income" # "Earnings" holds the key
    refute current.include?("Income")
    assert_equal "groceries", current.name_for_key("food.groceries").then { |name| current.node(name).name }
    assert_equal "Earnings", current.parent_of("Salary")
    assert_equal "My pets", current.node("My pets").name
    assert_equal 1, Finance::Category.where(user_id: @user.id).where("lower(name) = 'groceries'").count
    assert_equal "Food & dining", current.parent_of("Restaurants")
    # Running it again changes nothing.
    assert_empty Finance::Category.add_suggested!(@user)
  end

  test "categories nest without a depth limit and a move cannot create a cycle" do
    parent = nil
    names = %w[Level1 Level2 Level3 Level4 Level5 Level6]
    names.each { |name| parent = Finance::Category.create_for!(@user, name: name, parent: parent) }
    current = tree
    assert_equal 5, current.node("Level6").depth
    assert_equal names, current.path_names("Level6")
    assert_equal names, current.subtree("Level1")
    assert_equal "Level1 › Level2 › Level3 › Level4 › Level5 › Level6", current.path("Level6")

    error = assert_raises(Finance::Category::Invalid) { category("Level1").move_to!(category("Level4")) }
    assert_equal "category_cycle", error.code
    assert_raises(Finance::Category::Invalid) { category("Level3").move_to!(category("Level3")) }
    assert_nil category("Level1").parent_id
  end

  test "moving a subtree under a root of another kind changes its kind and its entries follow" do
    side = Finance::Category.create_for!(@user, name: "Side gigs")
    Finance::Category.create_for!(@user, name: "Tutoring", parent: side)
    money_in = entry("Tutoring", amount: "40.00", description: "Tutoring session", kind: "refund")
    assert_equal "refund", money_in.reload.kind

    side.move_to!(category("Income"))
    assert_equal "income", category("Side gigs").category_kind
    assert_equal "income", category("Tutoring").category_kind
    assert_equal "income", money_in.reload.kind
  end

  test "renaming rewrites every stored use of the name and keys still resolve" do
    spent = entry("Groceries")
    Finance::MerchantRule.create!(user: @user, merchant_key: "fresh mart", income: false, category: "Groceries")
    Finance::Budget.create!(user: @user, period: "month", category: "Groceries", amount: 300, alert_percent: 90)
    rule = Finance::RecurringRule.create!(user: @user, name: "Weekly shop", template: {"category" => "Groceries", "kind" => "expense"}, frequency: "weekly", start_on: Date.new(2026, 10, 1))

    assert category("Groceries").rename!("Supermarket")
    assert_equal "Supermarket", spent.reload.category
    assert_equal "Supermarket", @user.finance_merchant_rules.sole.category
    assert_equal "Supermarket", @user.finance_budgets.sole.category
    assert_equal "Supermarket", rule.reload.template["category"]
    assert_equal "Supermarket", Finance::Category.name_for_key(@user, "food.groceries")

    # A deleted key falls back to its parent, then to Uncategorized.
    category("Supermarket").remove!
    assert_equal "Food & dining", Finance::Category.name_for_key(@user, "food.groceries")
    category("Food & dining").remove!
    assert_equal "Uncategorized", Finance::Category.name_for_key(@user, "food.groceries")
  end

  test "names stay unique ignoring case at every depth and Uncategorized is reserved" do
    tree
    taken = Finance::Category.new(user_id: @user.id, name: "GROCERIES", category_kind: "expense")
    refute taken.valid?
    assert taken.errors.of_kind?(:name, :taken)
    reserved = Finance::Category.new(user_id: @user.id, name: "uncategorized", category_kind: "expense")
    refute reserved.valid?
    assert reserved.errors.of_kind?(:name, :reserved)
    refute category("Rent").rename!("salary")
  end

  test "deleting a category moves entries to its parent and its children up, keeping their order" do
    food = category("Food & dining")
    coffee = category("Coffee & tea")
    Finance::Category.create_for!(@user, name: "Espresso", parent: coffee)
    Finance::Category.create_for!(@user, name: "Matcha", parent: coffee)
    spent = entry("Coffee & tea")
    Finance::MerchantRule.create!(user: @user, merchant_key: "bean bar", income: false, category: "Coffee & tea")

    moved = coffee.remove!
    assert_equal 1, moved
    assert_equal "Food & dining", spent.reload.category
    assert_equal "Food & dining", @user.finance_merchant_rules.sole.category
    current = tree
    assert_equal "Food & dining", current.parent_of("Espresso")
    assert_equal %w[Espresso Matcha], current.node("Food & dining").children.map(&:name).last(2)
    refute current.include?("Coffee & tea")

    # A root's entries go to Uncategorized and its rules are forgotten.
    Finance::MerchantRule.create!(user: @user, merchant_key: "travel co", income: false, category: "Travel")
    trip = entry("Travel")
    category("Travel").remove!
    assert_equal "Uncategorized", trip.reload.category
    assert_empty @user.finance_merchant_rules.where(merchant_key: "travel co")
    assert_nil food.reload.parent_id
  end

  test "budgets move with a deleted category unless the destination already has one for the period" do
    Finance::Budget.create!(user: @user, period: "month", category: "Restaurants", amount: 100, alert_percent: 90)
    Finance::Budget.create!(user: @user, period: "month", category: "Takeout & delivery", amount: 50, alert_percent: 90)
    Finance::Budget.create!(user: @user, period: "month", category: "Food & dining", amount: 500, alert_percent: 90)
    category("Restaurants").remove!(move_to: "Bars & alcohol")
    assert_equal ["Bars & alcohol"], @user.finance_budgets.where(amount: 100).pluck(:category)
    category("Takeout & delivery").remove!
    assert_empty @user.finance_budgets.where(amount: 50)
  end

  test "merging moves entries, rules and children into the target and refuses its own descendants" do
    coffee = category("Coffee & tea")
    Finance::Category.create_for!(@user, name: "Espresso", parent: coffee)
    spent = entry("Coffee & tea")
    coffee.merge_into!(category("Restaurants"))
    assert_equal "Restaurants", spent.reload.category
    assert_equal "Restaurants", tree.parent_of("Espresso")

    food = category("Food & dining")
    error = assert_raises(Finance::Category::Invalid) { food.merge_into!(category("Espresso")) }
    assert_equal "category_cycle", error.code
  end

  test "Transfers can be renamed and given subcategories but not deleted, merged or nested" do
    transfers = category("Transfers")
    assert transfers.rename!("Money moves")
    assert_equal "Money moves", Finance::Category.name_for_key(@user, "transfers")
    sub = Finance::Category.create_for!(@user, name: "Savings sweep", parent: transfers)
    assert_equal "transfer", sub.category_kind
    assert_equal "Money moves", tree.transfer_category
    assert_equal "Savings sweep", tree.transfer_category("Savings sweep")

    %i[remove!].each { |action| assert_equal "protected", assert_raises(Finance::Category::Invalid) { transfers.public_send(action) }.code }
    assert_equal "protected", assert_raises(Finance::Category::Invalid) { transfers.merge_into!(category("Shopping")) }.code
    assert_equal "protected", assert_raises(Finance::Category::Invalid) { transfers.move_to!(category("Shopping")) }.code
    transfers.reorder!(-1)

    # Choosing anything in the transfer subtree makes an entry a transfer.
    moved = entry("Groceries")
    moved.update!(category: "Savings sweep")
    assert_equal "transfer", moved.reload.kind
  end

  test "a category means itself plus its descendants for budgets, filters and reports" do
    Finance::Category.create_for!(@user, name: "Farmers market", parent: "Groceries")
    entry("Food & dining", amount: "-5.00", description: "Snack")
    entry("Groceries", amount: "-20.00", description: "Market")
    entry("Farmers market", amount: "-7.00", description: "Stall")
    entry("Shopping", amount: "-100.00", description: "Shoes")

    current = tree
    assert_equal ["Food & dining", "Groceries", "Farmers market"], current.subtree("Food & dining") & ["Food & dining", "Groceries", "Farmers market"]
    scope = @user.finance_transactions.where(category: current.subtree("Groceries"))
    assert_equal 27, -scope.sum(:amount)

    filtered = Finance::SmartCommand::TransactionFilter.apply(@user.finance_transactions, {"category" => "Food & dining"}, user: @user)
    assert_equal 3, filtered.count

    report = Finance::LedgerReport.new(user: @user)
    roots = report.by("category")
    assert_equal BigDecimal("32"), roots["Food & dining"][:expense]
    assert_equal BigDecimal("100"), roots["Shopping"][:expense]
    refute roots.key?("Groceries")
    drill = report.by("category", node: "Food & dining")
    assert_equal BigDecimal("27"), drill["Groceries"][:expense]
    assert drill["Groceries"][:drill]
    assert drill["Food & dining"][:direct]
    assert_equal BigDecimal("5"), drill["Food & dining"][:expense]
    leaf = report.by("category", node: "Farmers market")
    assert_equal({"Farmers market" => BigDecimal("7")}, leaf.transform_values { |row| row[:expense] })
    refute leaf["Farmers market"][:direct]

    breakdown = Finance::SpendingBreakdown.new(user: @user)
    assert_equal({"Shopping" => 100.0, "Food & dining" => 32.0}, breakdown.mix[:parts].to_h { |part| [part[:key], part[:amount].to_f] })
  end

  test "the categorizer files rule matches under the person's current name for the key" do
    categorizer = Finance::Categorizer.new(user: @user)
    assert_equal "Food & dining", categorizer.categorize("STARBUCKS STORE 1", BigDecimal("-4"))
    category("Food & dining").rename!("Eating")
    assert_equal "Eating", Finance::Categorizer.new(user: @user).categorize("STARBUCKS STORE 1", BigDecimal("-4"))
    category("Transfers").rename!("Moves")
    assert_equal "Moves", Finance::Categorizer.new(user: @user).categorize("ONLINE TRANSFER TO SAVINGS", BigDecimal("-50"))
    assert_equal "Business", Finance::Categorizer.new(user: @user).categorize("ADOBE CREATIVE", BigDecimal("-20"))
  end

  test "deleting financial data removes the tree and the next read starts from the defaults" do
    Finance::Category.create_for!(@user, name: "Pets")
    Finance::DataDeletion.call(user: @user)
    assert_equal 0, Finance::Category.where(user_id: @user.id).count
    assert_nil @user.reload.finance_categories_seeded_at
    assert_equal 84, Finance::Category.for_user(@user).count
  end

  test "the limit is 500 categories, defaults included" do
    rows = (1..(Finance::Category::MAX_PER_USER - 84)).map { |i| {user_id: @user.id, name: "Extra #{i}", category_kind: "expense", created_at: Time.current, updated_at: Time.current} }
    tree
    Finance::Category.insert_all!(rows)
    record = Finance::Category.new(user_id: @user.id, name: "One more", category_kind: "expense")
    refute record.valid?
    assert record.errors.of_kind?(:base, :too_many)
    assert_equal "Uncategorized", Finance::Category.ensure_for!(@user, "Brand new")
  end
end
