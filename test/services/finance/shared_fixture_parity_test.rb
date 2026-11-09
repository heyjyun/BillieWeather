require "test_helper"

# The cross-platform clients (packages/finance-core) port the Rails import and dashboard
# logic. Both sides import the same synthetic statements and must produce the totals in
# packages/finance-core/fixtures/expected/snapshot.json (also checked by
# packages/finance-core/test/snapshot-parity.test.ts).
class Finance::SharedFixtureParityTest < ActiveSupport::TestCase
  FIXTURES = Rails.root.join("packages/finance-core/fixtures")

  test "Rails import + Snapshot match the shared expected dashboard totals" do
    user = create(:onboarded_user, usage_region: "US")
    Dir[FIXTURES.join("statements/*.csv")].sort.each do |path|
      file = Rack::Test::UploadedFile.new(path, "text/csv", original_filename: File.basename(path))
      Finance::StatementImporter.new(user: user, file: file, currency: "USD").call
    end

    snapshot = Finance::Snapshot.new(user: user).to_h
    cents = ->(decimal) { (decimal.to_d * 100).to_i }
    actual = {
      "incomeCents" => cents.call(snapshot[:income]),
      "expensesCents" => cents.call(snapshot[:expenses]),
      "netCents" => cents.call(snapshot[:net]),
      "transactionCount" => snapshot[:transaction_count],
      "statementCount" => snapshot[:statement_count],
      "uncategorizedCount" => snapshot[:uncategorized_count],
      "taxReviewCount" => snapshot[:tax_review_count],
      "transferCount" => snapshot[:transfer_count],
      "periodStart" => snapshot[:period_start]&.iso8601,
      "periodEnd" => snapshot[:period_end]&.iso8601,
      "categories" => snapshot[:categories].map { |category| {"name" => category[:name], "amountCents" => cents.call(category[:amount])} },
      "monthly" => snapshot[:monthly].map do |month|
        {"month" => month[:month].iso8601, "incomeCents" => cents.call(month[:income]), "expensesCents" => cents.call(month[:expenses]), "netCents" => cents.call(month[:net])}
      end
    }
    expected = JSON.parse(File.read(FIXTURES.join("expected/snapshot.json")))
    assert_equal expected, actual
  end
end
