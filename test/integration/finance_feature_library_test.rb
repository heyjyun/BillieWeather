require "test_helper"

# Settings › Feature Library and the module-driven sidebar on the website (Phase 1a). Synthetic data only.
class FinanceFeatureLibraryTest < ActionDispatch::IntegrationTest
  include Devise::Test::IntegrationHelpers

  CSV_TEXT = "Date,Description,Amount\n2026-01-03,SYNTHETIC GROCER,-42.10\n2026-01-09,ACME PAYROLL,2500.00\n"

  setup do
    @user = create(:onboarded_user, usage_region: "US")
    Finance::Profile.find_or_create_by!(user_id: @user.id) { |profile| profile.currency = "USD" }
    sign_in @user
  end

  def sidebar_labels
    css_select("#module-nav a.bw-nav-link .bw-nav-text").map { |node| node.text.strip }
  end

  def toggle(id, enabled, **options)
    patch finance_feature_library_module_path(id), params: {enabled: enabled ? "1" : "0"}.merge(options[:params] || {}), as: options[:as]
  end

  def import_sample
    stream = StringIO.new(CSV_TEXT)
    stream.define_singleton_method(:original_filename) { "synthetic.csv" }
    Finance::StatementImporter.new(user: @user, file: stream, currency: "USD").call
  end

  # Row counts and a digest of every finance table this person owns.
  def finance_fingerprint
    Finance::DataDeletion::MODELS.to_h do |model|
      rows = model.where(user_id: @user.id).map { |row| row.attributes.to_json }.sort
      [model.table_name, [rows.length, Digest::SHA256.hexdigest(rows.join("\n"))]]
    end
  end

  test "a new person sees Transactions, AI Assistant and Settings only, in both modes" do
    get finance_dashboard_path
    assert_response :success
    assert_equal ["Transactions", "AI Assistant", "Settings"], sidebar_labels
    assert_select "#module-nav a.is-active", text: "Transactions"
    assert_select "#transactions-tabs .bw-tab", count: 3
    assert_select "#transactions-tabs .bw-tab.is-active", text: "Overview"

    patch finance_mode_path, params: {mode: "manual"}
    get finance_transactions_path
    assert_response :success
    assert_select "#manual-mode-badge"
    assert_equal ["Transactions", "AI Assistant", "Settings"], sidebar_labels, "the mode does not change the module list"
    assert_select "#transactions-tabs .bw-tab.is-active", text: "All Transactions"
  end

  test "an existing person with data gets the same new default sidebar and keeps every record" do
    import_sample
    Finance::Budget.create!(user: @user, period: "month", amount: "100.00")
    before = finance_fingerprint
    get finance_dashboard_path
    assert_equal ["Transactions", "AI Assistant", "Settings"], sidebar_labels
    get finance_transactions_path
    assert_select "body", /SYNTHETIC GROCER/
    assert_equal before, finance_fingerprint
  end

  test "turning a module on adds it to the sidebar; off removes it; data is untouched and comes back" do
    import_sample
    Finance::Budget.create!(user: @user, period: "month", amount: "123.00")
    Finance::Book.default_for(@user) # the Budgets page creates the default book on first visit
    before = finance_fingerprint

    toggle("budgets", true)
    assert_equal before, finance_fingerprint, "turning on changes no financial record"
    assert_redirected_to finance_feature_library_path
    follow_redirect!
    assert_equal ["Transactions", "AI Assistant", "Budgets", "Settings"], sidebar_labels
    get finance_budgets_path
    assert_response :success
    assert_select "#module-disabled", count: 0
    assert_select "body", /123/

    toggle("budgets", false)
    get finance_dashboard_path
    assert_equal ["Transactions", "AI Assistant", "Settings"], sidebar_labels
    assert_equal before, finance_fingerprint, "a module toggle never changes financial records"

    toggle("budgets", true)
    get finance_budgets_path
    assert_select "body", /123/, "re-enabled module shows the same data"
  end

  test "the switch answers JSON with the new sidebar, without a reload" do
    toggle("reports", true, as: :json)
    assert_response :success
    body = response.parsed_body
    assert_equal({"module" => "reports", "enabled" => true}, body.slice("module", "enabled"))
    assert_includes body["nav"], "id=\"module-nav\""
    assert_includes body["nav"], "Reports"
    assert_match(/Reports is on/, body["message"])
  end

  test "coming-soon modules cannot be turned on and have no page; unknown modules are refused" do
    %w[goals household ledgers multi_currency].each do |id|
      toggle(id, true, as: :json)
      assert_response :unprocessable_entity
      assert_equal "coming_soon", response.parsed_body["error"]
    end
    toggle("crypto", true, as: :json)
    assert_response :not_found
    patch "/app/settings/features/settings", params: {enabled: "0"}, as: :json
    assert_response :not_found, "Settings is not a module"
    assert_empty Finance::ModulePreference.where(user: @user)
    get finance_feature_library_path
    assert_select "#module-goals .bw-badge-soon", text: "Coming soon"
    assert_select "#module-goals form", count: 0
    assert_select "#module-goals [role=switch][aria-disabled=true]"
  end

  test "core modules can be turned off; Settings always stays" do
    toggle("transactions", false)
    toggle("ai_assistant", false)
    get finance_settings_path
    assert_response :success
    assert_equal ["Settings"], sidebar_labels
    get finance_feature_library_path
    assert_response :success
  end

  test "opening a hidden module's page shows a safe 'turned off' page that can turn it on" do
    patch finance_mode_path, params: {mode: "default"}
    get finance_accounts_path
    assert_response :success
    assert_select "#module-disabled[data-module=accounts]"
    assert_select "h1", "Accounts & Assets is turned off"
    assert_select "#manual-mode-badge", {count: 0}, "a hidden manual page does not switch Manual Mode on"
    assert_select "form[action='#{finance_feature_library_module_path("accounts")}'] input[name=return_to][value='/app/accounts']"

    patch finance_feature_library_module_path("accounts"), params: {enabled: "1", return_to: "/app/accounts"}
    assert_redirected_to "/app/accounts"
    follow_redirect!
    assert_select "#module-disabled", count: 0
  end

  test "writes to a hidden module are refused without changing anything" do
    assert_no_difference -> { Finance::Budget.count } do
      post finance_budgets_path, params: {budget: {period: "month", amount: "50"}}
    end
    assert_response :forbidden
  end

  test "return_to only goes to this app's own pages" do
    ["https://evil.example/app", "//evil.example/app", "/app//evil", "/users/sign_out", "javascript:alert(1)"].each do |target|
      patch finance_feature_library_module_path("reports"), params: {enabled: "1", return_to: target}
      assert_redirected_to finance_feature_library_path
    end
  end

  test "hidden pages stay protected by sign-in and by ownership" do
    toggle("accounts", true)
    other = create(:onboarded_user, usage_region: "US")
    account = Finance::BankAccount.create!(user: other, manual: true, name: "Not mine", account_type: "cash", currency: "USD")
    get edit_finance_account_path(account)
    assert_response :not_found
    sign_out @user
    get finance_feature_library_path
    assert_redirected_to new_user_session_path
  end

  test "recurring entries still post while Recurring & Bills is hidden" do
    cash = Finance::BankAccount.create!(user: @user, manual: true, name: "Synthetic cash", account_type: "cash", currency: "USD")
    Finance::RecurringRule.create!(user: @user, name: "Synthetic rent", frequency: "monthly", interval: 1, start_on: Date.current << 1, auto_post: true,
      template: {"kind" => "expense", "amount" => "10.00", "account_id" => cash.id, "category" => "Housing"})
    refute Finance::ModuleCatalog.enabled?("recurring", Finance::ModuleCatalog.choices_for(@user))
    get finance_transactions_path
    assert_response :success
    assert Finance::Transaction.where(user_id: @user.id, entry_origin: "recurring").exists?, "hiding a module never stops processing"
  end

  test "Add & Sync lists the four capabilities and marks bank connections as coming soon" do
    get finance_add_sync_path
    assert_response :success
    assert_select "#transactions-tabs .bw-tab.is-active", text: "Add & Sync"
    assert_select "#capability-connect .bw-badge-soon", text: "Coming soon"
    assert_select "#capability-connect a, #capability-connect form, #capability-connect button", {count: 0}, "no fake connection flow"
    assert_select "#capability-import a[href='#{finance_statements_path}']"
    assert_select "#capability-scan a[href='#{finance_receipts_path}']"
    assert_select "#capability-quick-add a[href='#{new_finance_entry_path}']"
    assert_select "#capability-quick-add form[action=?]", preview_quick_finance_entries_path
    get finance_statements_path
    assert_select "#transactions-tabs .bw-tab.is-active", text: "Add & Sync"
    assert_select "#transactions-tabs .bw-subtab.is-active", text: "Statements"
  end

  test "Settings links to the Feature Library and the library shows every module with a filter" do
    get finance_settings_path
    assert_select "#settings-feature-library a[href='#{finance_feature_library_path}']"
    get finance_feature_library_path
    assert_select ".bw-library-card", count: Finance::ModuleCatalog::MODULES.length
    assert_select "#module-transactions [role=switch][aria-checked=true]"
    assert_select "#module-budgets [role=switch][aria-checked=false]"
    get finance_feature_library_path(filter: "coming_soon")
    assert_select ".bw-library-card:not([hidden])", count: 4
    get finance_feature_library_path(filter: "enabled")
    assert_select ".bw-library-card:not([hidden])", count: 2
  end

  test "preferences persist across sessions" do
    toggle("forecast", true)
    sign_out @user
    sign_in @user
    get finance_dashboard_path
    assert_equal ["Transactions", "AI Assistant", "Cash Flow Forecast", "Settings"], sidebar_labels
  end

  test "no dead ends: pages that had their own sidebar link are reachable from their module's tabs" do
    get finance_insights_path
    assert_select "#module-tabs a[href='#{finance_tax_preparation_path}']", text: "Tax preparation"
    get finance_tax_preparation_path
    assert_response :success
    assert_select "#module-nav a.is-active", text: "AI Assistant"
    toggle("reports", true)
    toggle("categories", true)
    get finance_ledger_report_path
    assert_select "#module-tabs a[href='#{finance_report_path}']"
    get finance_categories_path
    assert_select "#module-tabs a[href='#{finance_dimension_index_path("merchants")}']"
    get finance_transactions_path
    assert_select "#transactions-tabs a[href='#{finance_activity_path}']"
    get finance_add_sync_path
    %w[statements receipts reconciliation].each { |page| assert_select "#transactions-tabs a[href='/app/#{page}']" }
  end
end
