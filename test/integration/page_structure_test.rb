require "test_helper"

# Every signed-in page: one main heading, and no id used twice (labels and scripts would pick the wrong one).
class PageStructureTest < ActionDispatch::IntegrationTest
  include Devise::Test::IntegrationHelpers
  include BillieModules::SignInWithFullSidebar

  PAGES = %w[/app /app/accounts /app/accounts/new /app/activity /app/add /app/budgets /app/categories /app/entries/new
    /app/forecast /app/insights /app/manual /app/receipts /app/reconciliation /app/recurring /app/recurring/new /app/report
    /app/reports /app/review/duplicates /app/review/income /app/settings /app/settings/features /app/statements /app/tax
    /app/transactions /app/trash].freeze

  test "pages have one main heading and unique ids" do
    sign_in create(:user)
    PAGES.each do |path|
      get path
      assert_response :success, path
      page = Nokogiri::HTML(response.body)
      ids = page.css("[id]").map { |node| node["id"] }
      assert_equal [], ids.tally.select { |_, count| count > 1 }.keys, path
      assert_equal 1, page.css("h1").size, path
    end
  end

  test "pages cannot be framed, rebased or host plugins" do
    ["/users/sign_in", "/about"].each do |path|
      get path
      assert_equal "object-src 'none'; base-uri 'self'; frame-ancestors 'self'", response.headers["Content-Security-Policy"], path
    end
  end
end
