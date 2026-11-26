require "test_helper"

# Manual Mode (progressive disclosure): the default interface stays simple; the manual bookkeeping
# workspace appears only after the person chooses it; both modes use the same records.
class FinanceManualModeTest < ActionDispatch::IntegrationTest
  include Devise::Test::IntegrationHelpers
  # Exercises optional modules (hidden by default since the Feature Library): sign people in with them on.
  # Manual Mode itself is unchanged (product decision 2); its marker in the shell is #manual-mode-badge.
  include BillieModules::SignInWithFullSidebar

  setup do
    @user = create(:onboarded_user, usage_region: "US")
    sign_in @user
  end

  def switch_to(mode, return_to: nil)
    patch finance_mode_path, params: {mode: mode, return_to: return_to}.compact
  end

  def record_counts
    [@user.finance_transactions.count, @user.finance_bank_accounts.count, @user.finance_audit_events.count,
      @user.finance_merchants.count, @user.finance_budgets.count, Finance::Snapshot.new(user: @user).to_h.slice(:income, :expenses)]
  end

  test "the first visit shows the simple interface with a Manual button and no manual controls" do
    get finance_dashboard_path
    assert_response :success
    assert_select "#mode-switch button[value=manual][aria-pressed=false]", /Manual/
    assert_select "#mode-switch button[value=default][aria-pressed=true]"
    assert_select "#manual-mode-badge", 0
    # Since the Feature Library (Phase 1a) the sidebar follows the person's modules, not the mode
    # (this class turns every module on); Statements sits under Transactions › Add & Sync.
    assert_select "#module-nav a[href='#{finance_accounts_path}']"
    assert_select "#module-nav a[href='#{finance_budgets_path}']"
    assert_select "#transactions-tabs a[href='#{finance_add_sync_path}']"

    get finance_transactions_path
    assert_select "#add-entry", 0
    assert_select "#ledger-links", 0
    assert_select "#batch-form", 0
    assert_select "select[name=account_id]", 0
    assert_select "select[name=kind] option[value=transfer]", 0

    get finance_categories_path
    assert_select "details:not([open]) #category-tree"
  end

  test "Manual opens the complete workspace; Default hides it again without touching records" do
    switch_to("manual", return_to: finance_dashboard_path)
    assert_redirected_to finance_dashboard_path
    get finance_manual_path
    assert_response :success
    assert_select "h1", "Manual bookkeeping"
    assert_select "#mode-switch button[value=manual][aria-pressed=true]"
    assert_select "#manual-mode-badge"
    assert_select "main a[href='#{finance_accounts_path}']"
    assert_select "main a[href='#{finance_budgets_path}']"
    assert_select "main a[href='#{finance_ledger_report_path}']"
    assert_select "#transactions-tabs a[href='#{finance_add_sync_path}']" # automatic tools stay reachable
    %w[record organize plan review].each { |group| assert_select "#manual-group-#{group} .bw-tool-card" }
    assert_select "#quick-add a", Finance::Ledger::MANUAL_KINDS.size

    # Create, edit and delete supported objects through the workspace.
    post finance_accounts_path, params: {finance_bank_account: {custom_name: "ZXQ Wallet", account_type: "cash", opening_balance: "100", include_in_net_worth: "1"}}
    wallet = @user.finance_bank_accounts.find_by!(custom_name: "ZXQ Wallet")
    post finance_entries_path, params: {entry: {kind: "expense", amount: "12.50", booked_on: "2026-10-09", account_id: wallet.id, category: "Shopping", merchant_name: "ZXQ Cafe"}}
    assert_redirected_to finance_transactions_path
    coffee = @user.finance_transactions.sole
    patch finance_entry_path(coffee), params: {entry: {kind: "expense", amount: "13.00", booked_on: "2026-10-09", account_id: wallet.id, category: "Shopping"}}
    assert_equal BigDecimal("-13"), coffee.reload.amount
    post finance_budgets_path, params: {budget: {amount: "200", period: "monthly"}}

    get finance_transactions_path
    assert_select "#add-entry"
    assert_select "#ledger-links"
    assert_select "#batch-form"
    assert_select "a[href='#{edit_finance_entry_path(coffee)}']"

    before = record_counts
    switch_to("default", return_to: finance_transactions_path)
    assert_redirected_to finance_transactions_path
    follow_redirect!
    assert_select "#manual-mode-badge", 0
    assert_select "#add-entry", 0
    assert_select "#batch-form", 0
    get finance_transactions_path(tools: "manual")
    assert_select "#batch-form"
    assert_select "#mode-switch button[value=default][aria-pressed=true]"
    get finance_transactions_path
    # The same entry, now reviewed through the simple form.
    assert_select "strong", "ZXQ Cafe"
    assert_select "a[href='#{edit_finance_transaction_path(coffee)}']"
    get edit_finance_transaction_path(coffee)
    assert_response :success
    assert_select "input[name='finance_transaction[merchant_name]']", 0
    assert_equal before, record_counts

    switch_to("manual")
    switch_to("default")
    assert_equal before, record_counts
    assert_equal BigDecimal("87"), wallet.reload.balance
  end

  test "switching workflows keeps the current page and rejects unsafe destinations" do
    switch_to("manual")
    switch_to("default", return_to: finance_accounts_path)
    assert_redirected_to finance_accounts_path
    switch_to("default", return_to: finance_manual_path)
    assert_redirected_to finance_manual_path
    switch_to("default", return_to: "https://example.com/app")
    assert_redirected_to finance_dashboard_path
    switch_to("default", return_to: "//example.com/app")
    assert_redirected_to finance_dashboard_path
    switch_to("default", return_to: finance_forecast_path)
    assert_redirected_to finance_forecast_path
    switch_to("anything-else")
    get finance_dashboard_path
    assert_select "#manual-mode-badge", 0
  end

  test "both accounting workflows can open accounts and manual home" do
    get finance_accounts_path
    assert_response :success
    assert_select "#manual-mode-badge", 0
    get finance_manual_path
    assert_select "#mode-switch button[value=manual][aria-pressed=false]"
  end

  test "the manual workspace and its forms keep drafts and work in Simplified and Traditional Chinese" do
    get finance_dashboard_path, params: {locale: "zh-CN"}
    assert_select "#mode-switch button[value=manual]", /手动记账/
    switch_to("manual")
    get finance_manual_path, params: {locale: "zh-CN"}
    assert_select "h1", "手动记账"
    assert_select "#manual-mode-badge"
    get finance_manual_path, params: {locale: "zh-TW"}
    assert_select "h1", "手動記帳"
    assert_select "#mode-switch button[value=default]", /AI 自動/
    post finance_accounts_path, params: {finance_bank_account: {custom_name: "ZXQ 现金", account_type: "cash", opening_balance: "0"}}
    get new_finance_entry_path, params: {locale: "zh-TW"}
    assert_select "form#entry-form[data-draft-key='entry-new-expense']"
    assert_select "body[data-draft-restored]"
  end

  test "book settings: rename the book from the manual workspace" do
    switch_to("manual")
    patch finance_manual_book_path, params: {book: {name: "ZXQ Household"}}
    assert_redirected_to finance_manual_path
    assert_equal "ZXQ Household", Finance::Book.default_for(@user).name
    follow_redirect!
    assert_select "#book-settings input[value='ZXQ Household']"
    patch finance_manual_book_path, params: {book: {name: ""}}
    assert_equal "ZXQ Household", Finance::Book.default_for(@user).name
  end

  test "manual edits reach the AI command context and reports in either mode" do
    switch_to("manual")
    post finance_accounts_path, params: {finance_bank_account: {custom_name: "ZXQ Cash", account_type: "cash", opening_balance: "0", include_in_net_worth: "1"}}
    cash = @user.finance_bank_accounts.find_by!(custom_name: "ZXQ Cash")
    post finance_entries_path, params: {entry: {kind: "income", amount: "300", booked_on: Date.current.iso8601, account_id: cash.id, category: "Income"}}
    switch_to("default")
    get finance_dashboard_path
    assert_response :success
    assert_equal BigDecimal(300), Finance::Snapshot.new(user: @user).to_h[:income]
    get finance_command_context_path, as: :json
    assert_response :success
  end
end
