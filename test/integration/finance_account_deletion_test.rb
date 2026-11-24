require "test_helper"

# Deleting an account that receipts point at (Phase 0.5, audit R1). The receipts foreign key has no
# ON DELETE action, so a plain destroy raised ActiveRecord::InvalidForeignKey and a 500.
# The account must be refused with an actionable message and nothing may be deleted. Synthetic data only.
class FinanceAccountDeletionTest < ActionDispatch::IntegrationTest
  include Devise::Test::IntegrationHelpers
  # Exercises optional modules (hidden by default since the Feature Library): sign people in with them on.
  include BillieModules::SignInWithAllModules

  setup do
    @user = create(:onboarded_user, usage_region: "US")
    Finance::Profile.find_or_create_by!(user_id: @user.id) { |profile| profile.currency = "USD" }
    sign_in @user
    patch finance_mode_path, params: {mode: "manual"}
    @account = Finance::BankAccount.create!(user: @user, manual: true, name: "Synthetic wallet", account_type: "cash", currency: "USD")
  end

  test "an account with a receipt is refused, not a 500, and the receipt and account stay" do
    receipt = Finance::Receipt.create!(user: @user, bank_account: @account, source: "manual", merchant_name: "Synthetic Cafe", total: "4.50", currency: "USD")
    assert_no_difference -> { Finance::BankAccount.count } do
      assert_no_difference -> { Finance::Receipt.count } do
        delete finance_account_path(@account)
      end
    end
    assert_redirected_to finance_accounts_path
    assert_equal "Synthetic wallet has receipts attached to it, so it can't be deleted. Archive it to hide it instead; the receipts stay.", flash[:alert]
    assert_equal @account.id, receipt.reload.bank_account_id
    assert_not Finance::AuditEvent.where(user: @user, subject_type: "BankAccount", action: "delete").exists?

    # Archiving remains the way out, and keeps the receipt link.
    patch archive_finance_account_path(@account)
    assert @account.reload.archived?
    assert_equal @account.id, receipt.reload.bank_account_id
  end

  test "an unused account is still deleted and audited" do
    delete finance_account_path(@account)
    assert_redirected_to finance_accounts_path
    assert_not Finance::BankAccount.exists?(@account.id)
    assert Finance::AuditEvent.where(user: @user, subject_type: "BankAccount", action: "delete").exists?
  end

  test "a foreign-key race is turned into the in-use message instead of a 500" do
    Finance::BankAccount.class_eval { alias_method :__original_destroy!, :destroy! }
    Finance::BankAccount.define_method(:destroy!) { raise ActiveRecord::InvalidForeignKey, "synthetic race" }
    delete finance_account_path(@account)
    assert_redirected_to finance_accounts_path
    assert_match "can't be deleted", flash[:alert]
    assert Finance::BankAccount.exists?(@account.id)
  ensure
    Finance::BankAccount.class_eval do
      alias_method :destroy!, :__original_destroy!
      remove_method :__original_destroy!
    end
  end
end
