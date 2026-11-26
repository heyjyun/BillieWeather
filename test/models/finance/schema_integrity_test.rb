require "test_helper"

# The database itself keeps one person's finance rows apart from another's and refuses values the
# models would refuse, also for writes that skip model validations (insert_all!, update_all,
# update_columns). Migration 20261116000100. All data here is synthetic.
class FinanceSchemaIntegrityTest < ActiveSupport::TestCase
  setup do
    @owner = create(:onboarded_user)
    @other = create(:onboarded_user)
    @account = account_for(@owner)
    @statement = statement_for(@owner, @account)
    @entry = Finance::Transaction.find(Finance::Transaction.insert_all!([row], returning: [:id]).rows.flatten.first)
    @others_account = account_for(@other)
    @others_statement = statement_for(@other, @others_account)
    @others_entry = Finance::Transaction.find(Finance::Transaction.insert_all!([row(user_id: @other.id, statement_id: @others_statement.id, bank_account_id: @others_account.id)], returning: [:id]).rows.flatten.first)
  end

  test "a bulk insert cannot attach an entry to another person's statement or account" do
    refused(ActiveRecord::InvalidForeignKey) { Finance::Transaction.insert_all!([row(statement_id: @others_statement.id)]) }
    refused(ActiveRecord::InvalidForeignKey) { Finance::Transaction.insert_all!([row(bank_account_id: @others_account.id)]) }
    refused(ActiveRecord::InvalidForeignKey) { Finance::Transaction.insert_all!([row(user_id: @other.id)]) }
    assert_equal 1, Finance::Transaction.where(user_id: @owner.id).count
  end

  test "a bulk update cannot move an entry or a statement across people" do
    refused(ActiveRecord::InvalidForeignKey) { Finance::Transaction.where(id: @entry.id).update_all(bank_account_id: @others_account.id) }
    refused(ActiveRecord::InvalidForeignKey) { Finance::Transaction.where(id: @entry.id).update_all(user_id: @other.id) }
    refused(ActiveRecord::InvalidForeignKey) { @statement.update_columns(bank_account_id: @others_account.id) }
    assert_equal [@owner.id, @account.id], @entry.reload.values_at(:user_id, :bank_account_id)
  end

  test "merchants, projects and recurring rules of another person cannot be referenced" do
    merchant = Finance::Merchant.create!(user: @other, name: "Synthetic merchant")
    project = Finance::Project.create!(user: @other, name: "Synthetic project")
    refused(ActiveRecord::InvalidForeignKey) { Finance::Transaction.where(id: @entry.id).update_all(merchant_id: merchant.id) }
    refused(ActiveRecord::InvalidForeignKey) { Finance::Transaction.where(id: @entry.id).update_all(project_id: project.id) }
    refused(ActiveRecord::InvalidForeignKey) { Finance::Budget.insert_all!([{user_id: @owner.id, period: "month", project_id: project.id, amount: 10, created_at: Time.current, updated_at: Time.current}]) }
  end

  test "a link or a tag cannot join rows of two people" do
    now = Time.current
    link = {user_id: @owner.id, link_type: "transfer", from_transaction_id: @entry.id, to_transaction_id: @others_entry.id, created_at: now, updated_at: now}
    refused(ActiveRecord::InvalidForeignKey) { Finance::TransactionLink.insert_all!([link]) }
    refused(ActiveRecord::InvalidForeignKey) { Finance::TransactionLink.insert_all!([link.merge(user_id: @other.id)]) }
    tag = Finance::Tag.create!(user: @other, name: "Synthetic tag")
    refused(ActiveRecord::InvalidForeignKey) { Finance::TransactionTag.insert_all!([{transaction_id: @entry.id, tag_id: tag.id, user_id: @owner.id}]) }
    refused(ActiveRecord::InvalidForeignKey) { Finance::TransactionTag.insert_all!([{transaction_id: @entry.id, tag_id: tag.id, user_id: @other.id}]) }
    assert_equal 0, Finance::TransactionLink.count + Finance::TransactionTag.count
  end

  test "tags added through the models carry the owner" do
    tag = Finance::Tag.create!(user: @owner, name: "Synthetic tag")
    @entry.tags << tag
    assert_equal [@owner.id], Finance::TransactionTag.where(transaction_id: @entry.id).pluck(:user_id)
    Finance::TransactionTag.find_or_create_by!(transaction_id: @entry.id, tag_id: Finance::Tag.create!(user: @owner, name: "Second tag").id)
    assert_equal [@owner.id], Finance::TransactionTag.where(transaction_id: @entry.id).distinct.pluck(:user_id)
  end

  test "values the models refuse are refused by the database too" do
    refused(ActiveRecord::StatementInvalid) { Finance::Transaction.where(id: @entry.id).update_all(category: "") }
    refused(ActiveRecord::StatementInvalid) { Finance::Transaction.where(id: @entry.id).update_all(category_source: "guess") }
    refused(ActiveRecord::StatementInvalid) { Finance::Transaction.where(id: @entry.id).update_all(amount: BigDecimal(10000000000000)) }
    refused(ActiveRecord::StatementInvalid) { Finance::Transaction.where(id: @entry.id).update_all(original_description: "") }
    refused(ActiveRecord::StatementInvalid) { Finance::Transaction.where(id: @entry.id).update_all("user_locked_fields = '{}'::jsonb") }
    refused(ActiveRecord::StatementInvalid) { @statement.update_columns(transaction_count: 0) }
    refused(ActiveRecord::StatementInvalid) { @statement.update_columns(sha256: "not-a-hash") }
    now = Time.current
    refused(ActiveRecord::StatementInvalid) do
      Finance::TransactionLink.insert_all!([{user_id: @owner.id, link_type: "refund_of", from_transaction_id: @entry.id, to_transaction_id: @entry.id, created_at: now, updated_at: now}])
    end
    refused(ActiveRecord::StatementInvalid) do
      Finance::TransactionLink.insert_all!([{user_id: @owner.id, link_type: "refund_of", from_transaction_id: @entry.id, amount: -1, created_at: now, updated_at: now}])
    end
  end

  test "deleting a merchant, project or recurring rule clears the reference and keeps the entry and its owner" do
    merchant = Finance::Merchant.create!(user: @owner, name: "Synthetic merchant")
    project = Finance::Project.create!(user: @owner, name: "Synthetic project")
    @entry.update_columns(merchant_id: merchant.id, project_id: project.id)
    merchant.delete
    project.delete
    assert_equal [nil, nil, @owner.id, BigDecimal("-12.34")], @entry.reload.values_at(:merchant_id, :project_id, :user_id, :amount)
  end

  test "removing an entry takes its links and tags with it, and deleting all data still works" do
    second = Finance::Transaction.find(Finance::Transaction.insert_all!([row(amount: BigDecimal("12.34"), kind: "refund")], returning: [:id]).rows.flatten.first)
    Finance::TransactionLink.create!(user: @owner, link_type: "refund_of", from_transaction: second, to_transaction: @entry, amount: BigDecimal("12.34"))
    second.tags << Finance::Tag.create!(user: @owner, name: "Synthetic tag")
    second.delete
    assert_equal 0, Finance::TransactionLink.where(user_id: @owner.id).count + Finance::TransactionTag.where(user_id: @owner.id).count
    Finance::DataDeletion.call(user: @owner)
    assert_equal 0, Finance::Transaction.where(user_id: @owner.id).count + Finance::Statement.where(user_id: @owner.id).count
    assert_equal 1, Finance::Transaction.where(user_id: @other.id).count, "another person's data is untouched"
  end

  private

  # A failed statement aborts the surrounding transaction in PostgreSQL: each attempt gets a savepoint.
  def refused(error, &block)
    assert_raises(error) { ActiveRecord::Base.transaction(requires_new: true, &block) }
  end

  def account_for(user)
    Finance::BankAccount.create!(user: user, manual: true, name: "Synthetic checking", account_type: "checking")
  end

  def statement_for(user, account)
    Finance::Statement.create!(user: user, filename: "synthetic.csv", currency: "USD", sha256: SecureRandom.hex(32), transaction_count: 1, bank_account: account)
  end

  def row(overrides = {})
    now = Time.current
    {user_id: @owner.id, statement_id: @statement.id, bank_account_id: @account.id, booked_on: Date.new(2026, 10, 1), description: "SYNTHETIC ROW",
     original_description: "SYNTHETIC ROW", amount: BigDecimal("-12.34"), category: "Shopping", kind: "expense", entry_origin: "import",
     category_source: "auto", created_at: now, updated_at: now}.merge(overrides)
  end
end
