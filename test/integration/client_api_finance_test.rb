require "test_helper"

# Read-only download of web financial data for the apps' local databases.
class ClientApiFinanceTest < ActionDispatch::IntegrationTest
  PASSWORD = "a-long-test-password-1"
  FIXTURE = Rails.root.join("packages/finance-core/fixtures/statements/basic-amount.csv")

  setup do
    @user = create(:onboarded_user, email: "sync@example.com", password: PASSWORD, password_confirmation: PASSWORD, usage_region: "US")
    @other = create(:onboarded_user, email: "other@example.com", usage_region: "US")
    [@user, @other].each do |user|
      Finance::StatementImporter.new(user: user, file: Rack::Test::UploadedFile.new(FIXTURE, "text/csv", original_filename: "basic-amount.csv"), currency: "USD").call
    end
    Finance::MerchantRule.remember!(user: @user, description: "ZED BAKERS 1", amount: -5, category: "Business")
    post "/api/client/v1/session", params: {email: @user.email, password: PASSWORD}, as: :json
    @auth = {"Authorization" => "Bearer #{response.parsed_body["token"]}"}
  end

  test "requires a valid token" do
    %w[/api/client/v1/finance /api/client/v1/finance/statements /api/client/v1/finance/transactions /api/client/v1/finance/rules].each do |path|
      get path, as: :json
      assert_response :unauthorized
    end
  end

  test "returns only the signed-in person's statements, transactions, and rules, with exact amounts" do
    get "/api/client/v1/finance/statements", headers: @auth, as: :json
    statements = response.parsed_body["statements"]
    assert_equal 1, statements.length
    assert_equal Finance::Statement.where(user_id: @user.id).pluck(:id), statements.map { |s| s["id"] }
    assert_equal({"filename" => "basic-amount.csv", "currency" => "USD", "transaction_count" => 9, "closing_balance" => "3448.65", "closing_balance_on" => "2026-02-11"},
      statements.first.slice("filename", "currency", "transaction_count", "closing_balance", "closing_balance_on"))

    get "/api/client/v1/finance/transactions", headers: @auth, as: :json
    rows = response.parsed_body["transactions"]
    assert_equal 9, rows.length
    assert rows.all? { |row| row["statement_id"] == statements.first["id"] }
    payroll = rows.find { |row| row["description"] == "ACME CORP PAYROLL" }
    assert_equal({"booked_on" => "2026-01-02", "amount" => "2500.0", "category" => "Income", "tax_review" => false, "excluded" => false},
      payroll.slice("booked_on", "amount", "category", "tax_review", "excluded"))
    assert_nil response.parsed_body["next_after_id"]
    other_ids = Finance::Transaction.where(user_id: @other.id).pluck(:id)
    assert_empty rows.map { |row| row["id"] } & other_ids

    get "/api/client/v1/finance/rules", headers: @auth, as: :json
    assert_equal [{"merchant_key" => "zed bakers", "income" => false, "category" => "Business"}], response.parsed_body["rules"]
  end

  test "pages transactions by id" do
    get "/api/client/v1/finance/transactions", params: {limit: 4}, headers: @auth
    first = response.parsed_body
    assert_equal 4, first["transactions"].length
    get "/api/client/v1/finance/transactions", params: {limit: 4, after_id: first["next_after_id"]}, headers: @auth
    second = response.parsed_body
    get "/api/client/v1/finance/transactions", params: {limit: 4, after_id: second["next_after_id"]}, headers: @auth
    third = response.parsed_body
    ids = [first, second, third].flat_map { |page| page["transactions"].map { |row| row["id"] } }
    assert_equal Finance::Transaction.where(user_id: @user.id).order(:id).pluck(:id), ids
    assert_nil third["next_after_id"]
  end

  test "the version changes when web data is edited, added, or deleted, and not otherwise" do
    version = -> { get("/api/client/v1/finance", headers: @auth, as: :json) && response.parsed_body["version"] }
    first = version.call
    assert_equal "USD", response.parsed_body["currency"]
    assert_equal 9, response.parsed_body["transaction_count"]
    assert_equal first, version.call

    travel 1.second do
      Finance::Transaction.where(user_id: @user.id).first.update!(category: "Shopping")
    end
    second = version.call
    refute_equal first, second

    Finance::Transaction.where(user_id: @user.id).last.destroy!
    refute_equal second, version.call

    # Another person's changes do not affect this version.
    third = version.call
    travel 2.seconds do
      Finance::Transaction.where(user_id: @other.id).first.update!(category: "Shopping")
    end
    assert_equal third, version.call
  end

  test "the apps cannot write financial data through this API" do
    %w[post patch put delete].each do |verb|
      assert_raises(ActionController::RoutingError) { Rails.application.routes.recognize_path("/api/client/v1/finance/transactions", method: verb) }
    end
  end
end
