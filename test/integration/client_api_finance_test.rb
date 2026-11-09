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

  test "the summary includes counts, the date range, and approximate storage" do
    get "/api/client/v1/finance", headers: @auth, as: :json
    body = response.parsed_body
    assert_equal [1, 9, 1, 0], body.values_at("statement_count", "transaction_count", "rule_count", "pending_import_count")
    assert_equal ["2026-01-02", "2026-02-11"], body.values_at("period_start", "period_end")
    assert body["storage_bytes"] > 500, "rows take real space"
    assert body["last_updated_at"].present?
    get "/api/client/v1/finance/statements", headers: @auth, as: :json
    assert_equal ["2026-01-02", "2026-02-11"], response.parsed_body["statements"].first.values_at("period_start", "period_end")
  end

  test "deletes one cloud statement at a time, only the person's own" do
    mine = Finance::Statement.find_by!(user_id: @user.id)
    theirs = Finance::Statement.find_by!(user_id: @other.id)
    delete "/api/client/v1/finance/statements/#{theirs.id}", headers: @auth, as: :json
    assert_response :not_found
    assert Finance::Statement.exists?(theirs.id)

    delete "/api/client/v1/finance/statements/#{mine.id}", headers: @auth, as: :json
    assert_response :success
    assert_equal({"id" => mine.id, "transactions" => 9}, response.parsed_body["deleted"])
    assert_equal 0, Finance::Transaction.where(user_id: @user.id).count
    assert_equal 1, Finance::MerchantRule.where(user_id: @user.id).count, "rules and the rest of the account stay"
    delete "/api/client/v1/finance/statements/#{theirs.id}", as: :json
    assert_response :unauthorized
  end

  test "deleting the whole cloud database needs the typed confirmation and only touches this person" do
    delete "/api/client/v1/finance", headers: @auth, as: :json
    assert_response :unprocessable_entity
    assert_equal 1, Finance::Statement.where(user_id: @user.id).count

    @user.update!(cloud_database_name: "Family books")
    delete "/api/client/v1/finance", params: {confirm: "delete"}, headers: @auth, as: :json
    assert_response :success
    assert_equal 0, Finance::Statement.where(user_id: @user.id).count
    assert_equal 0, Finance::Transaction.where(user_id: @user.id).count
    assert_equal 0, Finance::MerchantRule.where(user_id: @user.id).count
    assert_equal 1, Finance::Statement.where(user_id: @other.id).count, "other accounts are untouched"
    assert_equal "Family books", @user.reload.cloud_database_name, "the name stays"

    delete "/api/client/v1/finance", params: {confirm: "delete"}, as: :json
    assert_response :unauthorized
  end

  test "names the cloud database, and the summary returns the name" do
    patch "/api/client/v1/finance", params: {name: "  Home   books \u0007 "}, headers: @auth, as: :json
    assert_response :success
    assert_equal "Home books", response.parsed_body["name"]
    get "/api/client/v1/finance", headers: @auth, as: :json
    assert_equal "Home books", response.parsed_body["name"]
    patch "/api/client/v1/finance", params: {name: "x" * 61}, headers: @auth, as: :json
    assert_response :unprocessable_entity
    patch "/api/client/v1/finance", params: {name: ""}, headers: @auth, as: :json
    assert_nil response.parsed_body["name"]
  end

  def upload(statement, headers: @auth)
    post "/api/client/v1/finance/statements", params: {statement: statement}, headers: headers, as: :json
  end

  def statement_payload(sha: "a" * 64, currency: "USD", rows: nil)
    {filename: "from-mac.csv", currency: currency, sha256: sha, closing_balance: "90.50", closing_balance_on: "2026-02-02",
     transactions: rows || [
       {booked_on: "2026-02-01", description: "Coffee", amount: "-4.50", category: "Food & dining", tax_review: false, excluded: false},
       {booked_on: "2026-02-02", description: "Pay", amount: "95.00", category: "Income", tax_review: false, excluded: true}
     ]}
  end

  test "uploads one statement from a local database, once" do
    assert_difference -> { Finance::Statement.where(user_id: @user.id).count } => 1, -> { Finance::Transaction.where(user_id: @user.id).count } => 2 do
      upload(statement_payload)
    end
    assert_response :created
    assert_equal true, response.parsed_body["created"]
    statement = Finance::Statement.find(response.parsed_body["id"])
    assert_equal @user.id, statement.user_id
    assert_equal 2, statement.transaction_count
    assert_equal BigDecimal("90.50"), statement.closing_balance
    assert_equal [BigDecimal("-4.5"), BigDecimal("95")], statement.transactions.order(:booked_on).pluck(:amount)
    assert statement.transactions.find_by(description: "Pay").excluded

    assert_no_difference -> { Finance::Statement.count } do
      upload(statement_payload)
    end
    assert_response :success
    assert_equal false, response.parsed_body["created"]
    assert_equal statement.id, response.parsed_body["id"]
  end

  test "an upload is rejected when it would mix currencies or contains bad rows" do
    assert_no_difference -> { Finance::Statement.count } do
      upload(statement_payload(currency: "EUR"))
      assert_response :conflict
      assert_equal "USD", response.parsed_body["currency"]
      upload(statement_payload(rows: [{booked_on: "2026-02-01", description: "x", amount: "1.001", category: "Income"}]))
      assert_response :unprocessable_entity
      # Unknown names become custom categories (see finance_categories_test.rb); unusable ones are refused.
      upload(statement_payload(rows: [{booked_on: "2026-02-01", description: "x", amount: "1.00", category: "x" * 41}]))
      assert_response :unprocessable_entity
      upload(statement_payload(rows: [{booked_on: "2026-02-01", description: "x", amount: "1.00", category: "  "}]))
      assert_response :unprocessable_entity
      upload(statement_payload(rows: []))
      assert_response :unprocessable_entity
      upload(statement_payload(sha: "nothex"))
      assert_response :unprocessable_entity
      upload(statement_payload, headers: {})
      assert_response :unauthorized
    end
  end

  test "apps still cannot edit or replace individual transactions" do
    %w[post patch put delete].each do |verb|
      assert_raises(ActionController::RoutingError) { Rails.application.routes.recognize_path("/api/client/v1/finance/transactions", method: verb) }
    end
  end
end
