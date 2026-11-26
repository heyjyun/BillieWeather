require "test_helper"

# Malformed input from a device must be a controlled 4xx, never a 500, and must never write
# anything (Phase 0.5, audit R2 and adjacent paths). Synthetic data only.
class ClientApiUploadValidationTest < ActionDispatch::IntegrationTest
  PASSWORD = "a-long-test-password-1"
  ROW = {booked_on: "2026-02-01", description: "SYNTHETIC GROCER", amount: "-3.00", category: "Shopping", tax_review: false, excluded: false}.freeze

  setup do
    @user = create(:onboarded_user, password: PASSWORD, password_confirmation: PASSWORD, usage_region: "US")
    post "/api/client/v1/session", params: {email: @user.email, password: PASSWORD}, as: :json
    @auth = {"Authorization" => "Bearer #{response.parsed_body["token"]}"}
  end

  def upload(statement)
    post "/api/client/v1/finance/statements", headers: @auth, as: :json, params: {statement: statement}
  end

  def statement(**overrides)
    {filename: "app.csv", currency: "USD", sha256: "b" * 64, transactions: [ROW]}.merge(overrides)
  end

  def assert_refused(expected_error = "invalid")
    assert_response :unprocessable_entity
    assert_equal expected_error, response.parsed_body["error"]
  end

  test "a well-formed upload still works" do
    upload(statement)
    assert_response :created
    assert_equal 1, @user.finance_statements.count
  end

  test "malformed hashes are refused as invalid_sha256 and nothing is stored" do
    ["", "abc", "B" * 64, "g" * 64, "b" * 63, "b" * 65, "#{"b" * 63}\n", " #{"b" * 64}", ["b" * 64], {x: 1}, 12345].each do |bad|
      assert_no_difference -> { Finance::Statement.count + Finance::Transaction.count + Finance::Category.where(system_key: nil).count } do
        upload(statement(sha256: bad))
      end
      assert_refused("invalid_sha256")
    end
  end

  test "a missing hash is refused" do
    upload(statement.except(:sha256))
    assert_refused("invalid_sha256")
  end

  test "malformed statement shapes and values are 422, not 500" do
    [
      "just a string",
      ["an", "array"],
      statement(transactions: "not rows"),
      statement(transactions: {booked_on: "2026-02-01"}),
      statement(transactions: ["text row"]),
      statement(currency: "ZZZ"),
      statement(currency: ["USD"]),
      statement(filename: ""),
      statement(filename: {x: 1}),
      statement(closing_balance: "1e400"),
      statement(closing_balance: "9" * 20),
      statement(closing_balance: "NaN"),
      statement(closing_balance: "12.345"),
      statement(closing_balance: "10.00", closing_balance_on: "not a date"),
      statement(account: "Chase 1234"),
      statement(account: {institution: "Chase", last4: "123456789", kind: "checking"})
    ].each do |bad|
      assert_no_difference -> { Finance::Statement.count + Finance::Transaction.count } do
        post "/api/client/v1/finance/statements", headers: @auth, as: :json, params: {statement: bad}
      end
      assert_response :unprocessable_entity, "expected 422 for #{bad.inspect.first(120)}"
    end
  end

  test "malformed receipt payloads are 422, not 500" do
    [
      {receipt: {lines: ["a bare string line"]}},
      {receipt: {lines: "one string"}},
      {receipt: {lines: [{text: "TOTAL 4.00", confidence: "high"}], fields: "not a hash"}},
      {receipt: {file_base64: "!!!not base64!!!"}}
    ].each do |bad|
      assert_no_difference -> { Finance::Receipt.count + Finance::Transaction.count } do
        post "/api/client/v1/finance/receipts", headers: @auth, as: :json, params: bad
      end
      assert_response :unprocessable_entity, "expected 422 for #{bad.inspect.first(120)}"
    end

    # An over-long idempotency key is shortened by ReceiptIngestion (column limit 100), not a 500.
    post "/api/client/v1/finance/receipts", headers: @auth, as: :json, params: {receipt: {lines: [{text: "TOTAL 4.00", confidence: 0.9}], client_request_id: "x" * 500}}
    assert_response :created
  end
end
