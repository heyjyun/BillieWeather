require "test_helper"
require "stringio"
require_relative "../../support/billie_method_stub"

class Finance::BatchStatementImportTest < ActiveSupport::TestCase
  include BillieMethodStub

  setup do
    @user = create(:user)
    Finance::Profile.create!(user: @user, currency: "USD")
  end

  test "processing time limit preserves completed files and identifies every remaining file" do
    service = Finance::BatchStatementImport.new(user: @user, currency: "USD", files: [
      upload("first.csv", csv("First", -5)), upload("second.csv", csv("Second", -10))
    ])
    times = [0, 0, 26]
    service.define_singleton_method(:monotonic_time) { times.shift }

    results = service.call
    assert_equal ["imported", "failed"], results.map { |result| result[:status] }
    assert_equal ["first.csv", "second.csv"], results.map { |result| result[:filename] }
    assert_includes results.last[:message], "Not processed"
    assert_equal ["First"], @user.finance_transactions.pluck(:description)
    assert_equal 1, @user.finance_statements.count
  end

  test "post-import categorization errors roll back that files rows before reporting failure" do
    service = Finance::BatchStatementImport.new(user: @user, currency: "USD", files: [upload("first.csv", csv("First", -5))])
    results = nil
    stub_method(Finance::Categorizer, :recategorize_uncategorized!, ->(**) { raise Finance::StatementImporter::ImportError, "Categorization could not finish." }) do
      assert_no_difference ["Finance::Statement.count", "Finance::Transaction.count"] do
        results = service.call
      end
    end
    assert_equal "failed", results.first[:status]
    assert_includes results.first[:message], "could not finish"
  end

  test "an oversized individual file does not block another valid file within the batch limit" do
    service = Finance::BatchStatementImport.new(user: @user, currency: "USD", files: [
      upload("too-large.csv", "a" * (Finance::StatementImporter::MAX_BYTES + 1)), upload("valid.csv", csv("Valid", 100))
    ])
    results = service.call
    assert_equal ["failed", "imported"], results.map { |result| result[:status] }
    assert_includes results.first[:message], "2 MB"
    assert_equal ["Valid"], @user.finance_transactions.pluck(:description)
  end

  private

  def csv(description, amount)
    "Date,Description,Amount\n2026-11-01,#{description},#{amount}\n"
  end

  def upload(filename, content)
    stream = StringIO.new(content)
    stream.define_singleton_method(:original_filename) { filename }
    stream
  end
end
