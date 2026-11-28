require "test_helper"

class Finance::AssistantSafetyTest < ActiveSupport::TestCase
  setup do
    @user = create(:onboarded_user)
    Finance::Profile.create!(user: @user, currency: "USD")
    @cash = @user.finance_bank_accounts.create!(name: "Checking", account_type: "checking", manual: true, currency: "USD",
      opening_balance: 250, opening_balance_on: Date.new(2026,9,5), balance_snapshot: true)
    @card = @user.finance_bank_accounts.create!(name: "Card", account_type: "credit_card", manual: true, currency: "USD")
    @statement = @user.finance_statements.create!(filename: "synthetic.csv", sha256: "a" * 64, currency: "USD", transaction_count: 2)
    @ledger = Finance::Ledger.new(@user)
  end

  def entry(account, date, amount, text, kind)
    @user.finance_transactions.create!(statement: @statement,bank_account: account,booked_on: date,description: text,
      kind: kind,amount: amount,category: Finance::Transaction::UNCATEGORIZED)
  end

  test "historical imports do not inflate a dated balance and reconciliation uses the requested date" do
    entry(@cash,"2026-09-01",-90,"Historical groceries","expense")
    entry(@cash,"2026-09-10",50,"Deposit","income")
    assert_nil @cash.balance(as_of: Date.new(2026,9,4))
    assert_equal 300,@cash.balance
    @ledger.adjust_balance(@cash,200,on: Date.new(2026,9,5))
    assert_equal 250,@cash.reload.balance
    assert_raises(Finance::Ledger::Invalid) { @ledger.adjust_balance(@cash,10,on: Date.new(2026,9,4)) }
    @ledger.adjust_balance(@cash,210,on: Date.new(2026,9,8))
    assert_equal 260,@cash.reload.balance
    assert_equal 260,Finance::BankAccount.balances_for(@user)[@cash.id]
  end

  test "opposite statement entries need explicit fresh review before changing ledger totals" do
    out = entry(@cash,"2026-09-11",-60,"Card payment","expense")
    incoming = entry(@card,"2026-09-12",60,"Payment received","income")
    review = Finance::TransferReview.new(@user)
    revision = Finance::TransferReview.revision(review.candidates.sole)
    out.update!(description:"Corrected bank payment")
    assert_raises(Finance::Ledger::Invalid) { review.decide(revision,"confirm") }
    assert_empty @user.finance_transaction_links
    review.decide(Finance::TransferReview.revision(review.candidates.sole),"confirm")
    assert_equal "confirmed", @user.finance_transaction_links.sole.status
    assert_equal %w[card_payment card_payment],[out.reload.kind,incoming.reload.kind]
    assert_empty @user.finance_transactions.included
    assert_empty review.candidates
  end

  test "recommendation evidence uses the configured monthly budget and counted expenses" do
    @user.finance_budgets.create!(period:"month",amount:80,alert_percent:90)
    entry(@cash,"2026-09-10",-100,"Recorded expense","expense")
    facts = Finance::NextStepFacts.for(@user,Finance::Profile.find_by!(user: @user),Date.new(2026,9,12))
    assert_equal(-2000,facts[:remaining])
    assert_equal 1,facts[:budgets]
  end

  test "an explicit classification or a rejected relationship suppresses the proposal" do
    out = entry(@cash,"2026-09-11",-60,"Card payment","expense")
    entry(@card,"2026-09-12",60,"Payment received","income")
    review = Finance::TransferReview.new(@user)
    out.update!(user_locked_fields:["category"])
    assert_empty review.candidates
    out.update!(user_locked_fields:[])
    review.decide(Finance::TransferReview.revision(review.candidates.sole),"reject")
    assert_empty review.candidates
    assert_equal 2,@user.finance_transactions.included.count
  end
end
