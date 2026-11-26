require "test_helper"

# Settings › Feature Library and the sidebar on the website. Every available module works for every
# account; the Feature Library only chooses what the sidebar shows. Synthetic data only.
class FinanceFeatureLibraryTest < ActionDispatch::IntegrationTest
  include Devise::Test::IntegrationHelpers

  CSV_TEXT = "Date,Description,Amount\n2026-01-03,SYNTHETIC GROCER,-42.10\n2026-01-09,ACME PAYROLL,2500.00\n"

  setup do
    # This page's form contract is the one without device sync, whatever the caller's environment says.
    @prior_flag = ENV["BILLIE_MODULE_SYNC"]
    ENV["BILLIE_MODULE_SYNC"] = "0"
    @user = create(:onboarded_user, usage_region: "US")
    Finance::Profile.find_or_create_by!(user_id: @user.id) { |profile| profile.currency = "USD" }
    sign_in @user
  end

  teardown { ENV["BILLIE_MODULE_SYNC"] = @prior_flag }

  def sidebar_labels
    css_select("#module-nav a.bw-nav-link .bw-nav-text").map { |node| node.text.strip }
  end

  def toggle(id, visible, **options)
    patch finance_feature_library_module_path(id), params: {sidebar_visible: visible ? "1" : "0"}.merge(options[:params] || {}), as: options[:as]
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

  test "a new person sees Transactions, AI Insight and Settings only, in both modes" do
    get finance_dashboard_path
    assert_response :success
    assert_equal ["Transactions", "AI Insight", "Settings"], sidebar_labels
    assert_select "#module-nav a.is-active", text: "Transactions"
    assert_select "#transactions-tabs .bw-tab", count: 3
    assert_select "#transactions-tabs .bw-tab.is-active", text: "Overview"

    patch finance_mode_path, params: {mode: "manual"}
    get finance_transactions_path
    assert_response :success
    assert_select "#manual-mode-badge"
    assert_equal ["Transactions", "AI Insight", "Settings"], sidebar_labels, "the mode does not change the module list"
    assert_select "#transactions-tabs .bw-tab.is-active", text: "All Transactions"
  end

  test "an existing person with data gets the same new default sidebar and keeps every record" do
    import_sample
    Finance::Budget.create!(user: @user, period: "month", amount: "100.00")
    before = finance_fingerprint
    get finance_dashboard_path
    assert_equal ["Transactions", "AI Insight", "Settings"], sidebar_labels
    get finance_transactions_path
    assert_select "body", /SYNTHETIC GROCER/
    assert_equal before, finance_fingerprint
  end

  test "a new person can use every built module without changing anything" do
    {finance_accounts_path => "accounts", finance_categories_path => "categories", finance_budgets_path => "budgets",
     finance_ledger_report_path => "reports", finance_report_path => "reports", finance_recurring_rules_path => "recurring",
     finance_forecast_path => "forecast", finance_insights_path => "ai_assistant"}.each do |path, id|
      get path
      assert_module_page(id)
    end
    assert_equal ["Transactions", "AI Insight", "Settings"], sidebar_labels, "visiting pages does not change the sidebar"
    assert_empty Finance::ModulePreference.where(user: @user), "nothing had to be switched on"
  end

  test "showing a module adds it to the sidebar; hiding removes it; data is untouched either way" do
    import_sample
    Finance::Budget.create!(user: @user, period: "month", amount: "123.00")
    Finance::Book.default_for(@user) # the Budgets page creates the default book on first visit
    before = finance_fingerprint

    toggle("budgets", true)
    assert_equal before, finance_fingerprint, "turning on changes no financial record"
    assert_redirected_to finance_feature_library_path
    follow_redirect!
    assert_equal ["Transactions", "AI Insight", "Budgets", "Settings"], sidebar_labels
    get finance_budgets_path
    assert_response :success
    assert_select "#module-disabled", count: 0
    assert_select "body", /123/

    toggle("budgets", false)
    get finance_dashboard_path
    assert_equal ["Transactions", "AI Insight", "Settings"], sidebar_labels
    assert_equal before, finance_fingerprint, "a sidebar choice never changes financial records"

    get finance_budgets_path
    assert_module_page("budgets")
    assert_select "body", /123/, "a hidden module still shows its data"
  end

  test "the switch answers JSON with the new sidebar, without a reload" do
    toggle("reports", true, as: :json)
    assert_response :success
    body = response.parsed_body
    assert_equal({"module" => "reports", "sidebar_visible" => true}, body.slice("module", "sidebar_visible"))
    refute body.key?("enabled"), "the answer is about the sidebar, not about turning Reports on"
    assert_includes body["nav"], "id=\"module-nav\""
    assert_includes body["nav"], "Reports"
    assert_match(/Reports now appears in your sidebar/, body["message"])
  end

  test "the form name used before the rename (enabled) is still understood as the sidebar choice" do
    patch finance_feature_library_module_path("budgets"), params: {enabled: "1"}
    assert Finance::ModuleCatalog.sidebar_visible?("budgets", Finance::ModuleCatalog.choices_for(@user))
    patch finance_feature_library_module_path("budgets"), params: {}, as: :json
    assert_response :unprocessable_entity
  end

  test "coming-soon modules cannot be added to the sidebar and have no page; unknown modules are refused" do
    %w[goals household ledgers multi_currency].each do |id|
      toggle(id, true, as: :json)
      assert_response :unprocessable_entity
      assert_equal "not_available", response.parsed_body["error"]
    end
    toggle("crypto", true, as: :json)
    assert_response :not_found
    patch "/app/settings/features/settings", params: {enabled: "0"}, as: :json
    assert_response :not_found, "Settings is not a module"
    assert_empty Finance::ModulePreference.where(user: @user)
    get finance_feature_library_path
    assert_select "#module-goals .bw-caption", text: "Coming soon"
    assert_select "#module-goals form", count: 0
    assert_select "#module-goals [role=switch]", count: 0
    assert_select "#module-goals a", {count: 0}, "no Open link for something that does not exist"
  end

  test "core modules can be hidden from the sidebar and still work; Settings always stays" do
    toggle("transactions", false)
    toggle("ai_assistant", false)
    get finance_settings_path
    assert_response :success
    assert_equal ["Settings"], sidebar_labels
    get finance_feature_library_path
    assert_response :success
    get finance_dashboard_path
    assert_module_page("transactions")
    get finance_insights_path
    assert_module_page("ai_assistant")
  end

  test "a module that is not in the sidebar opens directly from Settings and from the Feature Library" do
    get finance_settings_path
    assert_select "#settings-feature-library #module-accounts[data-sidebar=false] a[href=?]", finance_accounts_path
    get finance_feature_library_path
    assert_select "#module-accounts[data-sidebar=false] a[href=?]", finance_accounts_path
    get finance_accounts_path
    assert_module_page("accounts")
  end

  test "writes to a module that is not in the sidebar work" do
    Finance::Book.default_for(@user)
    assert_difference -> { Finance::Budget.where(user_id: @user.id).count }, 1 do
      post finance_budgets_path, params: {budget: {period: "month", amount: "50"}}
    end
    refute Finance::ModuleCatalog.sidebar_visible?("budgets", Finance::ModuleCatalog.choices_for(@user))
  end

  test "return_to only goes to this app's own pages" do
    ["https://evil.example/app", "//evil.example/app", "/app//evil", "/users/sign_out", "javascript:alert(1)"].each do |target|
      patch finance_feature_library_module_path("reports"), params: {sidebar_visible: "1", return_to: target}
      assert_redirected_to finance_feature_library_path
    end
  end

  test "hidden pages stay protected by sign-in and by ownership" do
    other = create(:onboarded_user, usage_region: "US")
    account = Finance::BankAccount.create!(user: other, manual: true, name: "Not mine", account_type: "cash", currency: "USD")
    get edit_finance_account_path(account)
    assert_response :not_found
    sign_out @user
    get finance_feature_library_path
    assert_redirected_to new_user_session_path
  end

  test "recurring entries still post while Recurring & Bills is not in the sidebar" do
    cash = Finance::BankAccount.create!(user: @user, manual: true, name: "Synthetic cash", account_type: "cash", currency: "USD")
    Finance::RecurringRule.create!(user: @user, name: "Synthetic rent", frequency: "monthly", interval: 1, start_on: Date.current << 1, auto_post: true,
      template: {"kind" => "expense", "amount" => "10.00", "account_id" => cash.id, "category" => "Housing"})
    refute Finance::ModuleCatalog.sidebar_visible?("recurring", Finance::ModuleCatalog.choices_for(@user))
    assert Finance::ModuleCatalog.enabled?("recurring")
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
    get finance_feature_library_path(filter: "unavailable")
    assert_select ".bw-library-card:not([hidden])", count: 4
    get finance_feature_library_path(filter: "sidebar")
    assert_select ".bw-library-card:not([hidden])", count: 2
    get finance_feature_library_path(filter: "hidden")
    assert_select ".bw-library-card:not([hidden])", {count: 10}, "all available modules outside the default sidebar"
  end

  test "Settings renders switches, locked Settings, preview, and the Web data manager" do
    get finance_settings_path(locale: "zh-CN")
    assert_select "#settings-feature-library h2", text: "功能管理"
    assert_select "[data-sidebar-preview] li", count: 3
    assert_select "#module-data_management [role=switch][aria-checked=false]"
    assert_select ".bw-feature-locked", /始终显示/
    patch finance_feature_library_module_path("data_management"), params: {sidebar_visible: "1", settings: "1"}, as: :json
    assert_includes response.parsed_body.fetch("preview"), "数据管理"
    get finance_data_management_path
    assert_response :success
    assert_select "#module-nav a[aria-current=page][href=?]", finance_data_management_path
    assert_select "#settings-database"
    post finance_reset_feature_library_path, params: {settings: "1"}
    assert_redirected_to finance_settings_path(anchor: "settings-feature-library")
  end

  test "Settings is organized in sections from a registry, including database management" do
    get finance_settings_path
    Finance::SettingsSections.visible.each do |section|
      assert_select "#settings-index a[href='##{section.anchor}']"
      assert_select "##{section.anchor}", {count: 1}, "#{section.id} has its panel"
    end
    assert_select "#settings-index a[data-settings-section=database]"
  end

  test "Settings removes only the signed-in user's remembered classification rule" do
    mine = Finance::MerchantRule.create!(user: @user, merchant_key: "synthetic grocery", income: false, category: "Food & dining")
    foreign = Finance::MerchantRule.create!(user: create(:onboarded_user), merchant_key: "private merchant", income: false, category: "Food & dining")
    get finance_settings_path
    assert_select "#settings-rules", /synthetic grocery/
    assert_select "#settings-rules", {text: /private merchant/, count: 0}
    delete remove_rule_finance_settings_path(rule_id: foreign.id)
    assert_response :not_found
    assert Finance::MerchantRule.exists?(foreign.id)
    delete remove_rule_finance_settings_path(rule_id: mine.id)
    assert_redirected_to finance_settings_path(anchor: "settings-rules")
    refute Finance::MerchantRule.exists?(mine.id)
  end

  test "sidebar choices saved before the rename are kept" do
    Finance::ModulePreference.insert_all!([{user_id: @user.id, module_key: "reports", enabled: true, changed_at: Time.current, revision: 1, created_at: Time.current, updated_at: Time.current}])
    get finance_dashboard_path
    assert_equal ["Transactions", "AI Insight", "Reports", "Settings"], sidebar_labels
  end

  test "preferences persist across sessions" do
    toggle("forecast", true)
    sign_out @user
    sign_in @user
    get finance_dashboard_path
    assert_equal ["Transactions", "AI Insight", "Cash Flow Forecast", "Settings"], sidebar_labels
  end

  test "no dead ends: pages that had their own sidebar link are reachable from their module's tabs" do
    get finance_insights_path
    assert_select "#module-tabs a[href='#{finance_tax_preparation_path}']", text: "Tax preparation"
    get finance_tax_preparation_path
    assert_response :success
    assert_select "#module-nav a.is-active", text: "AI Insight"
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
