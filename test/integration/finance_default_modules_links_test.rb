require "test_helper"

# A person with the default Feature Library (only Transactions and AI Assistant on) never meets a
# link that ends on a "module is turned off" page. Export, which lives in the optional Reports
# module, is still one press away from Settings and the deletion dialogs.
class FinanceDefaultModulesLinksTest < ActionDispatch::IntegrationTest
  include Devise::Test::IntegrationHelpers

  setup do
    @user = create(:onboarded_user, usage_region: "US")
    Finance::Profile.create!(user: @user, currency: "USD", current_balance: "1500.00", balance_source: "manual")
    statement = Finance::Statement.create!(user: @user, filename: "default.csv", currency: "USD", sha256: "c" * 64, transaction_count: 3)
    [["2026-10-01", "Synthetic salary", "2000.00", "Income"], ["2026-10-05", "Synthetic groceries", "-80.00", "Food & dining"],
      ["2026-10-07", "Synthetic shoes", "-60.00", "Shopping"]].each do |booked_on, description, amount, category|
      Finance::Transaction.create!(user: @user, statement: statement, booked_on: booked_on, description: description, amount: amount, category: category)
    end
    sign_in @user
  end

  test "no link on the dashboard or in settings opens a turned-off module" do
    assert_equal %w[transactions ai_assistant], Finance::ModuleCatalog.enabled_modules(Finance::ModuleCatalog.choices_for(@user)).map(&:id)
    hrefs = [finance_dashboard_path, finance_settings_path].flat_map do |page|
      get page
      assert_module_page("transactions") if page == finance_dashboard_path
      css_select("a[href^='/app']").map { |link| link["href"].split("#").first }
    end.uniq
    assert_operator hrefs.size, :>, 5, "the crawl found the pages' links"
    hrefs.each do |href|
      get href
      next unless response.media_type == "text/html" && response.successful?
      disabled = css_select("#module-disabled").first
      assert_nil disabled, "#{href} opens the turned-off \"#{disabled && disabled["data-module"]}\" module for a default account"
    end
  end

  test "export before deleting: one press turns Reports on and opens the export" do
    get finance_settings_path
    forms = css_select("form[data-export-link='turn-on']")
    assert_equal 3, forms.size, "settings and both deletion dialogs offer the export"
    assert_select "a[href='#{finance_report_path}']", count: 0
    form = forms.first
    params = css_select(form, "input[type=hidden]").to_h { |input| [input["name"], input["value"]] }
    assert_equal finance_report_path, params["return_to"]
    patch form["action"], params: params.except("_method", "authenticity_token")
    assert_redirected_to finance_report_path
    follow_redirect!
    assert_module_page("reports")

    get finance_settings_path
    assert_select "#settings-privacy a[href='#{finance_report_path}']"
    assert_select "form[data-export-link='turn-on']", count: 0
  end

  test "when the optional modules are on, the dashboard links to them as before" do
    enable_modules!(@user, %w[reports forecast categories])
    get finance_dashboard_path
    assert_select "#dashboard-export-report"
    assert_select "a[href=?]", finance_forecast_path(edit: "1", anchor: "balance")
    assert_select "#dashboard-spending-mix a[href=?]", finance_categories_path
    assert_select "#dashboard-spending-mix .bw-mix-list a"
  end

  test "with them off, the dashboard shows the same figures without those links" do
    get finance_dashboard_path
    assert_select "#dashboard-export-report", count: 0
    assert_select "a[href^='#{finance_forecast_path}']", count: 0
    assert_select "#dashboard-spending-mix a", count: 0
    assert_select "#dashboard-spending-mix .bw-mix-name", minimum: 1
  end
end
