require "test_helper"
require "csv"

class Finance::TransactionCsvTest < ActiveSupport::TestCase
  def row(**attributes)
    Finance::Report::Row.new(booked_on: Date.new(2026, 2, 3), account: "Chase · Checking · ••1111", merchant: "Coffee Bar",
      description: "Coffee", category: "Food & dining", amount: BigDecimal("-4.50"), currency: "USD",
      tax_review: false, excluded: false, counted: true, **attributes)
  end

  test "UTF-8 with a byte-order mark, proper quoting and exact amounts" do
    body = Finance::TransactionCsv.generate([row(description: "Lunch, \"team\"\nsecond line"), row(description: "咖啡店 Tokyo", amount: BigDecimal(1200))])
    assert_equal Encoding::UTF_8, body.encoding
    assert body.start_with?("﻿")
    rows = CSV.parse(body.delete_prefix("﻿"), headers: true)
    assert_equal Finance::TransactionCsv::HEADERS, rows.headers
    assert_equal "Lunch, \"team\"\nsecond line", rows[0]["Description"]
    assert_equal "-4.5", rows[0]["Amount"]
    assert_equal "2026-02-03", rows[0]["Date"]
    assert_equal "咖啡店 Tokyo", rows[1]["Description"]
    assert_equal "1200.0", rows[1]["Amount"]
    assert_equal "Food & dining", rows[0]["Category"]
  end

  test "text that would start a formula is neutralized; numbers are not" do
    ["=1+1", "+SUM(A1)", "-2+3", "@cmd", "\tx", "\r=x", "  =x", "＝1+1"].each do |dangerous|
      value = Finance::TransactionCsv.safe_text(dangerous)
      assert value.start_with?("'"), "#{dangerous.inspect} should be prefixed"
    end
    ["Coffee", "100% cotton", "Rent - March", ""].each do |plain|
      assert_equal plain, Finance::TransactionCsv.safe_text(plain)
    end
    body = Finance::TransactionCsv.generate([row(description: "=HYPERLINK(1)", account: "@acct", merchant: "+m")])
    parsed = CSV.parse(body.delete_prefix("﻿"), headers: true).first
    assert_equal "'=HYPERLINK(1)", parsed["Description"]
    assert_equal "'@acct", parsed["Account"]
    assert_equal "'+m", parsed["Merchant"]
    assert_equal "-4.5", parsed["Amount"], "negative amounts stay numeric"
  end

  test "no rows still produces a header" do
    assert_equal ["﻿Date"], [CSV.parse(Finance::TransactionCsv.generate([])).first.first]
  end
end
