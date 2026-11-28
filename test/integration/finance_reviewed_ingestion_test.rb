require "test_helper"
require "caxlsx"

class FinanceReviewedIngestionTest < ActionDispatch::IntegrationTest
  include Devise::Test::IntegrationHelpers

  def upload
    Rack::Test::UploadedFile.new(@file.path, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", original_filename: "synthetic.xlsx")
  end

  test "preview and confirm a workbook through the statement pipeline, keeping source hash and account identity" do
    user = create(:onboarded_user, usage_region: "US")
    sign_in user
    @file = Tempfile.new(["assistant-statement", ".xlsx"])
    book = Axlsx::Package.new
    book.workbook.add_worksheet(name: "Checking") do |sheet|
      sheet.add_row ["Date", "Description", "Amount", "Currency", "Institution", "Account mask", "Account type", "Closing balance"]
      sheet.add_row ["2026-10-29", "Synthetic grocer", "-25.00","USD","Chase","4321","Checking","1500.00"]
    end
    book.serialize(@file.path)
    post preview_finance_statements_path(format: :json), params: {files: [upload]}
    assert_response :success
    result = response.parsed_body
    assert_equal 1, result["files"].first["count"], result.inspect
    assert_empty user.finance_bank_accounts
    assert_empty user.finance_transactions
    post finance_statements_path, params: {account_review: "1", review_token: "invalid", files: [upload]}
    assert_response :unprocessable_entity
    assert_empty user.finance_transactions
    post finance_statements_path, params: {account_review: "1", review_token: result["token"], files: [upload]}
    assert_response :success
    statement = user.finance_statements.sole
    assert_equal ["synthetic.xlsx", Digest::SHA256.file(@file.path).hexdigest, "4321"], [statement.filename, statement.sha256, statement.bank_account.last4]
    assert_equal 1, user.finance_transactions.count
    post finance_statements_path, params: {account_review: "1", review_token: result["token"], files: [upload]}
    assert_response :unprocessable_entity
    assert_equal 1, user.finance_transactions.count
  ensure
    @file&.close!
  end

  test "portable feedback uses bearer ownership, compares the previous value, and excludes book evidence" do
    owner = create(:onboarded_user, usage_region: "US")
    other = create(:onboarded_user, usage_region: "CN")
    path = "/api/client/v1/assistant_preferences"
    auth = ->(user) { {"Authorization" => "Bearer #{ClientApi::SessionToken.issue(user).first}"} }
    put path, params: {key: "enabled", value: false, expected: nil}, as: :json
    assert_response :unauthorized
    put path, params: {key: "enabled", value: false, expected: nil}, headers: auth.call(owner), as: :json
    assert_equal false, response.parsed_body["enabled"]
    put path, params: {key: "enabled", value: true, expected: nil}, headers: auth.call(owner), as: :json
    assert_equal false, response.parsed_body["enabled"]
    put path, params: {key: "reconcile:1", value: {status: "dismissed"}, expected: nil}, headers: auth.call(owner), as: :json
    assert_response :unprocessable_entity
    get path, headers: auth.call(other)
    assert_equal({}, response.parsed_body)
  end
end
