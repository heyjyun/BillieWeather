require "test_helper"

# Manual bookkeeping through the web UI, with synthetic data only and no AI: accounts, every entry type,
# edit, copy, delete, trash/restore/purge, batch edit + undo, categories (two levels, merge),
# merchants/projects/tags, budgets, recurring entries, review lists and reports.
class FinanceManualBookkeepingTest < ActionDispatch::IntegrationTest
  include Devise::Test::IntegrationHelpers
  # Exercises optional modules (hidden by default since the Feature Library): sign people in with them on.
  include BillieModules::SignInWithFullSidebar

  setup do
    @user = create(:onboarded_user, usage_region: "US")
    @other = create(:onboarded_user, usage_region: "US")
    sign_in @user
    # These flows run in the manual workspace (Manual Mode; see finance_manual_mode_test.rb).
    patch finance_mode_path, params: {mode: "manual"}
  end

  # Match the controller's actual user time zone; the factory may use a different calendar date.
  def today = Time.current.in_time_zone(@user.time_zone.presence || "America/Chicago").to_date

  def create_account(name, type, opening = "0")
    post finance_accounts_path, params: {finance_bank_account: {custom_name: name, account_type: type, opening_balance: opening, include_in_net_worth: "1"}}
    assert_redirected_to finance_accounts_path
    @user.finance_bank_accounts.find_by!(custom_name: name)
  end

  def add(entry)
    post finance_entries_path, params: {entry: entry}
    assert_redirected_to finance_transactions_path, flash[:alert].to_s
    @user.finance_transactions.order(:id).last
  end

  test "accounts: create every type, edit, reorder, adjust balance, archive, delete only when unused" do
    get finance_accounts_path
    assert_response :success
    assert_select "h1", "Accounts"
    get new_finance_account_path(type: "credit_card")
    assert_response :success
    Finance::BankAccount::TYPES.each { |type| create_account("Synthetic #{type}", type, "10.00") }
    wallet = @user.finance_bank_accounts.find_by!(custom_name: "Synthetic cash")
    card = @user.finance_bank_accounts.find_by!(custom_name: "Synthetic credit_card")
    assert card.liability?
    patch finance_account_path(card), params: {finance_bank_account: {custom_name: "ZXQ Card", account_type: "credit_card", opening_balance: "-250.00", credit_limit: "5000", statement_day: "20", due_day: "5"}}
    assert_redirected_to finance_accounts_path
    assert_equal [BigDecimal("-250"), BigDecimal(5000), 20, 5], card.reload.values_at(:opening_balance, :credit_limit, :statement_day, :due_day)

    get finance_accounts_path
    assert_select "#net-worth", /Net worth/
    assert_select "#account-#{card.id}", /ZXQ Card/

    post adjust_finance_account_path(wallet), params: {balance: "42.50", on: Date.current.iso8601}
    assert_redirected_to finance_accounts_path
    adjustment = @user.finance_transactions.sole
    assert_equal ["adjustment", BigDecimal("32.5")], [adjustment.kind, adjustment.amount]
    assert_equal BigDecimal("42.5"), wallet.reload.balance

    delete finance_account_path(wallet)
    assert_equal "Synthetic cash has entries or statements, so it can't be deleted. Archive it to hide it instead.", flash[:alert]
    patch archive_finance_account_path(wallet)
    assert wallet.reload.archived?
    patch unarchive_finance_account_path(wallet)
    assert_not wallet.reload.archived?

    savings = @user.finance_bank_accounts.find_by!(custom_name: "Synthetic savings")
    delete finance_account_path(savings)
    assert_not Finance::BankAccount.exists?(savings.id)

    other_account = Finance::BankAccount.create!(user: @other, manual: true, name: "Not mine", account_type: "cash")
    get edit_finance_account_path(other_account)
    assert_response :not_found
    assert Finance::AuditEvent.where(user: @user, subject_type: "BankAccount").count >= 10
  end

  test "typed Quick Add only prefills the usual form and requires explicit save" do
    sign_in @user
    checking = Finance::BankAccount.create!(user: @user, manual: true, name: "Synthetic cash", account_type: "cash", currency: "USD")
    assert_no_difference -> { @user.finance_transactions.count } do
      post preview_quick_finance_entries_path, params: {quick_entry: "收入 12,34 合成工资"}
      assert_response :success
      assert_select "#entry-form input[name='entry[kind]'][value='income']"
      assert_select "#entry-form input[name='entry[amount]'][value='12.34']"
      assert_select "#entry-form [name='entry[description]'][value='合成工资']"
      post preview_quick_finance_entries_path, params: {quick_entry: "transfer 5000"}
      assert_redirected_to finance_add_sync_path
    end
    assert_difference -> { @user.finance_transactions.count }, 1 do
      post finance_entries_path, params: {entry: {kind: "income", amount: "12.34", description: "合成工资",
                                                  booked_on: "2026-11-24", account_id: checking.id, category: "Income"}}
      assert_response :redirect
    end
    assert_equal BigDecimal("12.34"), @user.finance_transactions.last.amount
  end

  test "entries: expense, income, transfer, card payment, refund; edit, copy, delete, restore, purge" do
    checking = create_account("Checking", "checking", "1000")
    card = create_account("Card", "credit_card")
    cash = create_account("Wallet", "cash", "50")

    get new_finance_entry_path
    assert_response :success
    assert_select "#kind-tabs a", 5
    purchase = add(kind: "expense", amount: "80.00", booked_on: "2026-10-09", account_id: card.id, category: "Shopping", merchant_name: "ZXQ Outfitters", tag_names: "gift", note: "synthetic")
    assert_equal [BigDecimal(-80), "expense", "manual"], [purchase.amount, purchase.kind, purchase.entry_origin]
    salary = add(kind: "income", amount: "2000", booked_on: "2026-10-30", account_id: checking.id, category: "Income")
    get new_finance_entry_path(refund_of_id: purchase.id)
    assert_select "input[name='entry[kind]'][value='refund']"
    refund = add(kind: "refund", amount: "30", booked_on: "2026-10-15", account_id: card.id, refund_of_id: purchase.id)
    assert_equal ["refund", "Shopping"], [refund.kind, refund.category]
    payment = add(kind: "transfer", amount: "50", booked_on: "2026-10-28", account_id: checking.id, to_account_id: card.id)
    assert_equal "card_payment", payment.kind
    add(kind: "transfer", amount: "20", booked_on: "2026-10-20", account_id: checking.id, to_account_id: cash.id)

    post finance_entries_path, params: {entry: {kind: "refund", amount: "60", booked_on: "2026-10-16", account_id: card.id, refund_of_id: purchase.id}}
    assert_response :unprocessable_entity
    assert_includes flash[:alert], "more than what is left"
    post finance_entries_path, params: {entry: {kind: "expense", amount: "0", booked_on: "2026-10-16", account_id: card.id}}
    assert_response :unprocessable_entity
    assert_includes flash[:alert], "can't be zero"

    snapshot = Finance::Snapshot.new(user: @user).to_h
    assert_equal BigDecimal(2000), snapshot[:income]
    assert_equal BigDecimal(50), snapshot[:expenses]

    get edit_finance_entry_path(purchase)
    assert_response :success
    patch finance_entry_path(purchase), params: {entry: {kind: "expense", amount: "85", booked_on: "2026-10-09", account_id: card.id, category: "Health"}}
    assert_redirected_to finance_transactions_path
    assert_equal [BigDecimal(-85), "Health"], purchase.reload.values_at(:amount, :category)

    get new_finance_entry_path(copy_from: salary.id)
    assert_select "input[name='entry[amount]'][value='2000.0']"

    delete finance_entry_path(payment)
    assert_equal 2, @user.finance_transactions.trashed.count, "both legs of the card payment"
    get finance_trash_path
    assert_select "#trash-table tbody tr", 2
    patch restore_finance_entry_path(payment)
    assert_equal 0, @user.finance_transactions.trashed.count
    delete finance_entry_path(salary)
    delete purge_finance_entry_path(salary)
    assert_not Finance::Transaction.exists?(salary.id)

    get finance_transactions_path(kind: "refund")
    assert_select ".bw-results-heading strong", "1"
    get finance_transactions_path(account_id: card.id)
    assert_response :success
    get finance_transactions_path(kind: "manual")
    assert_response :success
    get finance_activity_path
    assert_select "#activity-table tbody tr", minimum: 8
  end

  test "imported entries keep the bank's amount and original text when edited" do
    statement = Finance::Statement.create!(user: @user, filename: "s.csv", currency: "USD", sha256: "c" * 64, transaction_count: 1)
    row = Finance::Transaction.create!(user: @user, statement: statement, booked_on: Date.new(2026, 10, 31), description: "ZELLE TO SAM Q", amount: -60, category: "Uncategorized")
    get edit_finance_transaction_path(row)
    assert_select "#original-description", /ZELLE TO SAM Q/
    patch finance_transaction_path(row), params: {finance_transaction: {description: "Dinner split with Sam", category: "Food & dining", merchant_name: "Sam", tag_names: "friends", note: "split"}}
    assert_redirected_to finance_transactions_path
    row.reload
    assert_equal ["ZELLE TO SAM Q", "Dinner split with Sam", "Food & dining", "Sam", ["friends"], BigDecimal(-60)],
      [row.original_description, row.description, row.category, row.merchant.name, row.tags.map(&:name), row.amount]
    patch finance_entry_path(row), params: {entry: {amount: "1", booked_on: "2020-01-01", description: "Dinner"}}
    assert_equal [BigDecimal(-60), Date.new(2026, 10, 31)], row.reload.values_at(:amount, :booked_on)
    # The merchant rule is learned from the original text, not the edited one.
    assert_equal "zelle to", @user.finance_merchant_rules.sole.merchant_key
  end

  test "batch change and undo from the activity log" do
    cash = create_account("Wallet", "cash", "50")
    a = add(kind: "expense", amount: "5", booked_on: "2026-10-01", account_id: cash.id)
    b = add(kind: "expense", amount: "6", booked_on: "2026-10-02", account_id: cash.id, category: "Health")
    get finance_transactions_path
    assert_select "#batch-form"
    assert_select "input[name='ids[]'][form='batch-form']", 2
    post batch_finance_transactions_path, params: {ids: [a.id, b.id], batch_action: "category", value: "Shopping"}
    assert_equal %w[Shopping Shopping], [a.reload.category, b.reload.category]
    batch_id = @user.finance_audit_events.where(action: "batch_update").pick(:batch_id)
    post finance_undo_activity_path(batch_id)
    assert_equal %w[Uncategorized Health], [a.reload.category, b.reload.category]
    post batch_finance_transactions_path, params: {ids: [a.id], batch_action: "delete"}
    assert a.reload.deleted_at
    post batch_finance_transactions_path, params: {ids: [Finance::Transaction.create!(user: @other, bank_account: Finance::BankAccount.create!(user: @other, manual: true, name: "x", account_type: "cash"), entry_origin: "manual", booked_on: Date.current, amount: -1, description: "theirs").id], batch_action: "delete"}
    assert_equal "Select at least one transaction.", flash[:alert]
  end

  test "categories: any depth, income tree, hide, merge" do
    post finance_categories_path, params: {category: {name: "Coffee"}}
    post finance_categories_path, params: {category: {name: "Cafes"}}
    post finance_categories_path, params: {category: {name: "Bonus"}}
    patch arrange_finance_categories_path, params: {name: "Coffee", arrangement: {category_kind: "expense", parent_name: "Food & dining", sort_order: "1", hidden: "0"}}
    patch arrange_finance_categories_path, params: {name: "Bonus", arrangement: {category_kind: "income", parent_name: "Income"}}
    # Depth is unlimited now (docs/architecture/category-hierarchy.md).
    patch arrange_finance_categories_path, params: {name: "Cafes", arrangement: {category_kind: "expense", parent_name: "Coffee"}}
    assert_nil flash[:alert]
    patch arrange_finance_categories_path, params: {name: "Coffee", arrangement: {parent_name: "Cafes"}}
    assert_match(/inside itself/, flash[:alert])
    tree = Finance::CategoryTree.new(@user)
    assert_equal "Food & dining", tree.parent_of("Coffee")
    assert_equal "Coffee", tree.parent_of("Cafes")
    assert_equal "income", tree.kind_of("Bonus")
    assert_equal ["Food & dining", "Coffee", "Cafes"], tree.with_children("Food & dining") & ["Food & dining", "Coffee", "Cafes"]
    assert_equal ["Coffee", "Cafes"], tree.with_children("Coffee")
    get finance_categories_path(name: "Coffee")
    assert_select "#category-tree li[data-category='Income']", /Bonus/
    assert_select "#arrange"

    cash = create_account("Wallet", "cash", "50")
    post finance_entries_path, params: {entry: {kind: "expense", amount: "1", booked_on: "2026-10-01", account_id: cash.id, category: "Bonus"}}
    assert_response :unprocessable_entity, "an income category can't hold an expense"
    entry = add(kind: "expense", amount: "4.50", booked_on: "2026-10-01", account_id: cash.id, category: "Cafes")
    delete finance_category_path(Finance::Category.where(user_id: @user.id).find_by!(name: "Cafes")), params: {move_to: "Coffee"}
    assert_equal "Coffee", entry.reload.category
    patch arrange_finance_categories_path, params: {name: "Housing", arrangement: {hidden: "1"}}
    assert Finance::CategoryTree.new(@user).hidden?("Housing")
    get new_finance_entry_path
    assert_select "select[name='entry[category]'] option[value='Housing']", 0
    assert_select "select[name='entry[category]'] option[value='Coffee']", /— Coffee/
  end

  test "merchants, projects and tags: create, rename, archive, merge, delete" do
    cash = create_account("Wallet", "cash", "50")
    %w[merchants projects tags].each do |dimension|
      post finance_dimension_create_path(dimension), params: {dimension: {name: "Alpha"}}
      post finance_dimension_create_path(dimension), params: {dimension: {name: "Beta"}}
      get finance_dimension_index_path(dimension)
      assert_select "#dimension-table tbody tr", 2
    end
    project = @user.finance_projects.find_by!(name: "Alpha")
    entry = add(kind: "expense", amount: "9", booked_on: "2026-10-01", account_id: cash.id, project_id: project.id, merchant_name: "Alpha", tag_names: "Alpha, Gamma")
    assert_equal ["Alpha", "Alpha", %w[Alpha Gamma]], [entry.project.name, entry.merchant.name, entry.tags.map(&:name).sort]
    patch finance_dimension_update_path("projects", project), params: {dimension: {name: "Trip 2026"}}
    assert_equal "Trip 2026", project.reload.name
    patch finance_dimension_update_path("projects", project), params: {archive: "1"}
    assert project.reload.archived?
    beta = @user.finance_projects.find_by!(name: "Beta")
    post finance_dimension_merge_path("projects", project), params: {into: beta.id}
    assert_equal beta, entry.reload.project
    tag = @user.finance_tags.find_by!(name: "Alpha")
    delete finance_dimension_destroy_path("tags", tag)
    assert_equal %w[Gamma], entry.reload.tags.map(&:name)
    get finance_transactions_path(project_id: beta.id)
    assert_select ".bw-results-heading strong", "1"
  end

  test "budgets warn at 90% and recurring entries post each date once" do
    cash = create_account("Wallet", "cash", "500")
    post finance_budgets_path, params: {budget: {scope: "category:Food & dining", period: "month", amount: "100", alert_percent: "90"}}
    post finance_budgets_path, params: {budget: {scope: "", period: "year", amount: "1000"}}
    add(kind: "expense", amount: "95", booked_on: today.iso8601, account_id: cash.id, category: "Food & dining")
    get finance_budgets_path
    assert_select "#budget-table .bw-budget-warning", 1
    assert_select "#budget-table .bw-budget-ok", 1

    post finance_recurring_rules_path, params: {recurring_rule: {name: "Rent", frequency: "monthly", interval: "1", start_on: (today << 2).iso8601,
                                                                 template: {kind: "expense", amount: "12.34", account_id: cash.id, category: "Housing"}}}
    assert_redirected_to finance_recurring_rules_path
    rule = @user.finance_recurring_rules.sole
    get finance_recurring_rules_path
    assert_select "#recurring-table", /Rent/
    post post_due_finance_recurring_rules_path
    assert_equal 3, @user.finance_transactions.where(recurring_rule: rule).count
    post post_due_finance_recurring_rules_path
    assert_equal 3, @user.finance_transactions.where(recurring_rule: rule).count, "posting twice changes nothing"
    patch toggle_finance_recurring_rule_path(rule)
    assert rule.reload.paused
    post finance_recurring_rules_path, params: {recurring_rule: {name: "Broken", frequency: "monthly", interval: "1", start_on: Date.current.iso8601, template: {kind: "expense", amount: "0", account_id: cash.id}}}
    assert_response :unprocessable_entity
  end

  test "review lists: suspect income and possible duplicates" do
    card = Finance::BankAccount.create!(user: @user, identity_key: "d" * 64, bank_name: "ZXQ Bank", name: "Credit account", last4: "9188", kind: "credit", account_type: "credit_card")
    statement = Finance::Statement.create!(user: @user, bank_account: card, filename: "old.csv", currency: "USD", sha256: "e" * 64, transaction_count: 2)
    legacy = Finance::Transaction.create!(user: @user, statement: statement, bank_account: card, booked_on: Date.new(2026, 10, 15), description: "ZXQ OUTFITTERS", amount: 30, category: "Income", kind: "income")
    Finance::Transaction.create!(user: @user, statement: statement, bank_account: card, booked_on: Date.new(2026, 10, 3), description: "ZXQMART STORE 0042 CHICAGO", amount: -25.99, category: "Shopping")
    get finance_transactions_path
    assert_select "#ledger-links", /1 income entry to check/
    get finance_review_income_path
    assert_select "#income-review tbody tr", 1
    patch finance_reclassify_income_path(legacy, kind: "refund")
    assert_equal "refund", legacy.reload.kind
    assert_equal BigDecimal(0), Finance::Snapshot.new(user: @user).to_h[:income]

    file = Rack::Test::UploadedFile.new(StringIO.new("Date,Description,Amount\n2026-10-03,ZXQMART STORE #42,-25.99\n"), "text/csv", original_filename: "new.csv")
    Finance::StatementImporter.new(user: @user, file: file, currency: "USD", bank_account: card).call
    get finance_review_duplicates_path
    assert_select "#duplicate-review tbody tr", 1
    link = @user.finance_transaction_links.where(link_type: "duplicate_of").sole
    patch finance_resolve_duplicate_path(link, decision: "duplicate")
    assert link.from_transaction.reload.deleted_at
    assert_equal "confirmed", link.reload.status
  end

  test "reports by kind and dimension, with net worth" do
    checking = create_account("Checking", "checking", "1000")
    card = create_account("Card", "credit_card")
    add(kind: "expense", amount: "80", booked_on: Date.current.iso8601, account_id: card.id, category: "Shopping", merchant_name: "ZXQ Shop")
    add(kind: "income", amount: "500", booked_on: Date.current.iso8601, account_id: checking.id, category: "Income")
    %w[category account merchant project tag].each do |dimension|
      get finance_ledger_report_path(dimension: dimension)
      assert_response :success
    end
    get finance_ledger_report_path(dimension: "merchant")
    assert_select "#report-table", /ZXQ Shop/
    assert_select "#report-metrics", /\$1,420.00/
  end
end
