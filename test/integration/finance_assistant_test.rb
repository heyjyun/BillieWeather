require "test_helper"

class FinanceAssistantTest < ActionDispatch::IntegrationTest
  include Devise::Test::IntegrationHelpers

  setup do
    @owner = create(:onboarded_user, usage_region: "US")
    @other = create(:onboarded_user, usage_region: "CA")
    sign_in @owner
    @rows = [{"name" => "Reviewed card", "type" => "credit_card", "currency" => "USD", "last4" => "1298",
      "institution" => "Chase", "amount" => "500.00", "date" => "2026-10-30"},
      {"name" => "Wallet", "type" => "payment_app", "currency" => "USD", "amount" => ""}]
    @batch = {key: SecureRandom.uuid, source: "text", confirmed: true, rows: @rows}
  end

  test "reviewed accounts are atomic, idempotent and owner scoped" do
    post finance_account_capture_path, params: @batch.merge(confirmed: false), as: :json
    assert_response :unprocessable_entity
    post finance_account_capture_path, params: @batch.merge(rows: [@rows.first, @rows.last.merge("currency" => "JPY")]), as: :json
    assert_response :unprocessable_entity
    assert_empty @owner.finance_bank_accounts
    2.times do
      post finance_account_capture_path, params: @batch, as: :json
      assert_response :success
      assert_equal 2, response.parsed_body["ids"].size
    end
    card, wallet = @owner.finance_bank_accounts.order(:id)
    assert_equal(-500, card.balance)
    assert_nil wallet.balance
    assert_equal 2, @owner.finance_audit_events.where(batch_id: @batch[:key]).count
    identity = Finance::StatementAccountIdentity.from_details(bank_name: "Chase", account_last4: "1298", account_kind: "credit")
    assert_equal card, Finance::BankAccount.resolve(user: @owner, identity: identity)
    post finance_account_capture_path, params: @batch.merge(key: SecureRandom.uuid), as: :json
    assert_response :conflict
    post adjust_finance_account_path(wallet), params: {balance: "0", on: Date.current.iso8601}
    assert_redirected_to finance_accounts_path
    assert_equal 0, wallet.reload.balance
    sign_out @owner
    sign_in @other
    get finance_next_steps_path, as: :json
    assert_response :success
    assert_empty response.parsed_body.dig("facts","accounts")
    get edit_finance_account_path(card)
    assert_response :not_found
  end

  test "undo is atomic and refuses a subsequent manual correction" do
    post finance_account_capture_path, params: @batch, as: :json
    @owner.finance_bank_accounts.first.update!(custom_name: "Corrected")
    post finance_undo_account_capture_path, params: {key: @batch[:key]}
    assert_equal 2,@owner.finance_bank_accounts.count
    next_batch = @batch.merge(key: SecureRandom.uuid,rows: [@rows.last.merge("name" => "Second wallet")])
    post finance_account_capture_path, params: next_batch, as: :json
    assert_response :success
    post finance_undo_account_capture_path, params: {key: next_batch[:key]}
    assert_equal 2,@owner.finance_bank_accounts.count
    assert_not @owner.finance_bank_accounts.exists?(name:"Second wallet")
    post finance_account_capture_path, params: next_batch, as: :json
    assert_response :unprocessable_entity
  end

  test "preferences survive requests without disclosing another owner's decisions" do
    patch finance_next_steps_path, params: {key: "account", value: {status: "dismissed"}}, as: :json
    assert_response :success
    get finance_next_steps_path, as: :json
    assert_equal "dismissed", response.parsed_body.dig("state","account","status")
    patch finance_next_steps_path, params: {key: "enabled", value: false}, as: :json
    get finance_next_steps_path, as: :json
    assert_nil response.parsed_body["facts"]
    sign_out @owner
    get finance_next_steps_path, as: :json
    assert_response :unauthorized
    sign_in @other
    get finance_next_steps_path, as: :json
    assert_equal({}, response.parsed_body["state"])
  end
end
