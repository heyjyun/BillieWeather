require "csv"

module Finance
  # Categorized transactions as CSV. Used by the report export and the Transactions page.
  # - UTF-8 with a byte-order mark, so spreadsheet apps read non-English merchant names correctly.
  # - Quoting and escaping are left to Ruby's CSV library.
  # - Text that a spreadsheet would run as a formula is prefixed with an apostrophe.
  #   Amounts are written as plain numbers and are never prefixed.
  class TransactionCsv
    BOM = "﻿".freeze
    HEADERS = ["Date", "Account", "Merchant", "Description", "Category", "Amount", "Currency", "Tax review", "Excluded", "Counted in totals"].freeze
    # =, +, -, @, tab and carriage return (and their full-width forms) start a formula in common spreadsheet apps.
    FORMULA_START = /\A[\s　]*[=+\-@\t\r＝＋－＠]/

    def self.safe_text(value)
      text = value.to_s
      text.match?(FORMULA_START) ? "'#{text}" : text
    end

    # `rows` yields Finance::Report::Row values.
    def self.generate(rows)
      body = CSV.generate(encoding: "UTF-8") do |csv|
        csv << HEADERS
        rows.each do |row|
          csv << [row.booked_on.iso8601, safe_text(row.account), safe_text(row.merchant), safe_text(row.description),
            safe_text(row.category), row.amount.to_d.to_s("F"), row.currency, row.tax_review, row.excluded, row.counted]
        end
      end
      BOM + body
    end
  end
end
