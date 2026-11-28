require "test_helper"

# A person with the default sidebar (Financial Overview and AI Insight) can still use every built module:
# links on the dashboard and in Settings lead to real pages, and export is one link away.
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

  test "every link on the dashboard and in settings opens a working page for a default account" do
    assert_equal %w[overview ai_assistant], Finance::ModuleCatalog.sidebar_modules(Finance::ModuleCatalog.choices_for(@user)).map(&:id)
    hrefs = [finance_dashboard_path, finance_settings_path].flat_map do |page|
      get page
      assert_module_page("overview") if page == finance_dashboard_path
      css_select("a[href^='/app']").map { |link| link["href"].split("#").first }
    end.uniq
    assert_operator hrefs.size, :>, 5, "the crawl found the pages' links"
    hrefs.each do |href|
      get href
      next unless response.media_type == "text/html"
      refute_equal 403, response.status, href
      refute_equal 404, response.status, href
      assert_select "#module-disabled", {count: 0}, href
    end
  end

  test "export before deleting is a plain link to the export, whatever the sidebar shows" do
    get finance_settings_path
    assert_select "a[data-export-link='report'][href='#{finance_report_path}']", count: 3
    assert_select "form[data-export-link='turn-on']", count: 0
    get finance_report_path
    assert_module_page("reports")
  end

  test "the dashboard links to Reports, Forecast and Categories for a default account" do
    get finance_dashboard_path
    assert_select "#dashboard-export-report"
    links = JSON.parse(css_select("#financial-overview").first["data-links"])
    assert_equal finance_forecast_path, links.fetch("forecast")
    assert_equal finance_categories_path, links.fetch("categories")
    assert_equal finance_transactions_path, links.fetch("transactions")
  end

  test "showing those modules in the sidebar changes only the sidebar" do
    get finance_dashboard_path
    before = css_select("main a").map { |link| link["href"] }.sort
    show_in_sidebar!(@user, %w[reports forecast categories])
    get finance_dashboard_path
    assert_equal before, css_select("main a").map { |link| link["href"] }.sort
  end
end
