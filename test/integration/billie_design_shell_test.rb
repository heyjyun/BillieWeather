require "test_helper"

# The redesigned app shell: shared design tokens, purple sidebar navigation (including
# Statements), the collapse control and the per-browser theme menu, in every language.
class BillieDesignShellTest < ActionDispatch::IntegrationTest
  include Devise::Test::IntegrationHelpers

  setup do
    @user = create(:onboarded_user, email: "design-shell@example.com", usage_region: "US")
  end

  test "pages load the generated design tokens before the site stylesheet" do
    get root_path
    assert_response :success
    links = css_select("link[rel=stylesheet]").map { |link| link["href"] }
    assert_operator links.index { |href| href.include?("billie-tokens.css") }, :<, links.index { |href| href.include?("/billie.css") }
    assert_select "script[src='/billie-theme.js']:not([defer])"
    assert File.exist?(Rails.root.join("public/billie-tokens.css"))
  end

  test "the sidebar lists Statements and marks the current page" do
    sign_in @user
    get finance_statements_path
    assert_response :success
    assert_select ".bw-sidebar .bw-nav a.bw-nav-link.is-active[aria-current='page'][href='#{finance_statements_path}']", text: "Statements"
    assert_select ".bw-nav a.bw-nav-link[title='Transactions'][href='#{finance_transactions_path}']"
    assert_select "button.bw-sidebar-toggle[data-sidebar-toggle][hidden][aria-controls='bw-sidebar'][aria-expanded='true']"
  end

  test "the theme menu offers System, Light and Dark and stays hidden until its script runs" do
    sign_in @user
    get finance_dashboard_path
    assert_select ".bw-topbar details.bw-theme-menu[data-theme-menu][hidden]" do
      assert_select "button[data-theme-choice]", count: 3
      assert_select "button[data-theme-choice='system'][aria-pressed='true']", text: "System"
    end
  end

  test "shell controls are translated" do
    sign_in @user
    {"zh-CN" => ["对账单", "收起侧边栏", "深色"], "zh-TW" => ["對帳單", "收合側邊欄", "深色"], "en" => ["Statements", "Collapse sidebar", "Dark"]}.each do |locale, (statements, collapse, dark)|
      get finance_dashboard_path(locale: locale)
      assert_select ".bw-nav a[href='#{finance_statements_path}']", text: statements
      assert_select "button.bw-sidebar-toggle[aria-label='#{collapse}']"
      assert_select "button[data-theme-choice='dark']", text: dark
    end
  end
end
