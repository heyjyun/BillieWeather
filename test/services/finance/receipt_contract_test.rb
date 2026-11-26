require "test_helper"

# Receipt contract shared with the TypeScript clients (packages/finance-core/test/receipt.test.ts): both
# sides replay the same fixtures and must agree on every field, level and reason.
class Finance::ReceiptContractTest < ActiveSupport::TestCase
  FIXTURES = Rails.root.join("packages/finance-core/fixtures/receipts")
  FIELDS = Finance::ReceiptParser::FIELDS

  def fixture(name) = JSON.parse(File.read(FIXTURES.join(name)))

  def assert_same(expected, actual, message = nil)
    expected.nil? ? assert_nil(actual, message) : assert_equal(expected, actual, message)
  end

  fixture_cases = JSON.parse(File.read(Rails.root.join("packages/finance-core/fixtures/receipts/parse-cases.json")))["cases"]
  fixture_cases.each do |c|
    test "parse: #{c["name"]}" do
      input = c["text"] || c["lines"].map { |line| line.is_a?(String) ? {text: line, confidence: nil} : line }
      options = c["options"] || {}
      result = Finance::ReceiptParser.parse(input, default_currency: options["defaultCurrency"], today: options["today"], date_order: options["dateOrder"],
        text_confidence: options["textConfidence"] || 0.9)
      expected = c["expect"]
      FIELDS.each { |name| assert_same expected[name], result.dig("fields", name, "value"), name if expected.key?(name) }
      assert_equal expected["direction"], result["direction"] if expected.key?("direction")
      assert_equal expected["issues"], result["issues"] if expected.key?("issues")
      assert_equal expected["confident"], Finance::ReceiptParser.confident?(result), "confident" if expected.key?("confident")
      assert_equal expected["lineItemCount"], result["lineItems"].length, "line items" if expected.key?("lineItemCount")
      if (item = expected["lineItem"])
        actual = result["lineItems"][item["index"]]
        item.except("index").each { |key, value| assert_same value, actual[key], "line item #{key}" }
      end
      (c["minConfidence"] || {}).each { |name, min| assert_operator result.dig("fields", name, "confidence"), :>=, min, name }
      (c["maxConfidence"] || {}).each { |name, max| assert_operator result.dig("fields", name, "confidence"), :<=, max, name }
      FIELDS.each { |name| assert_equal 0, result.dig("fields", name, "confidence") if result.dig("fields", name, "value").nil? }
    end
  end

  test "merchant identity keys and similarity bands" do
    merchants = fixture("match-cases.json")["merchants"]
    merchants["keys"].each { |text, key| assert_same key, Finance::MerchantIdentity.key(text), text }
    merchants["similarity"].each do |a, b, min, max|
      score = Finance::MerchantIdentity.similarity(a, b)
      if min.nil?
        assert_nil score, "#{a} / #{b}"
      else
        assert_operator score, :>=, min, "#{a} / #{b}"
        assert_operator score, :<=, max, "#{a} / #{b}"
      end
    end
  end

  match_cases = JSON.parse(File.read(Rails.root.join("packages/finance-core/fixtures/receipts/match-cases.json")))
  match_cases["cases"].each do |c|
    test "match: #{c["name"]}" do
      r = c["receipt"]
      receipt = {amount_minor: r["amountMinor"], direction: r["direction"], currency: r["currency"], date: r["date"], merchant: r["merchant"],
                 card_last4: r["cardLast4"], receipt_number: r["receiptNumber"], tip_minor: r["tipMinor"], confident: r["confident"]}
      candidates = c["candidates"].map do |x|
        {id: x["id"], amount_minor: x["amountMinor"], currency: x["currency"], date: x["date"], description: x["description"], kind: x["kind"],
         account_last4: x["accountLast4"], reference: x["reference"], has_receipt: x["hasReceipt"], rejected: x["rejected"]}
      end
      result = Finance::ReceiptMatcher.match(receipt, candidates)
      assert_equal c["expect"]["level"], result.level
      assert_same c["expect"]["ids"], result.best&.ids
      Array(c["expect"]["reasons"]).each { |reason| assert_includes result.best.reasons, reason }
      assert_equal c["expect"]["proposals"], result.proposals.length if c["expect"].key?("proposals")
      if result.level == "exact"
        assert (result.best.reasons & %w[merchant_same merchant_similar receipt_number_match]).any?, "exact never rests on the amount alone"
      end
    end
  end

  match_cases["duplicates"].each do |c|
    test "duplicate: #{c["name"]}" do
      convert = ->(x) { {id: x["id"], sha256: x["sha256"], amount_minor: x["amountMinor"], date: x["date"], time: x["time"], merchant: x["merchant"], receipt_number: x["receiptNumber"]} }
      result = Finance::ReceiptMatcher.duplicate(convert.call(c["incoming"]), c["existing"].map(&convert))
      expected = c["expect"] && {kind: c["expect"]["kind"], of: c["expect"]["of"]}
      assert_same expected, result
    end
  end
end
