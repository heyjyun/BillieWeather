# Generates expected/*.json from the Rails implementation. See README.md.
# Run: RAILS_ENV=test bin/rails runner packages/finance-core/fixtures/generate_expected.rb
require "json"
require "ostruct"

root = File.expand_path(__dir__)
out = File.join(root, "expected")
Dir.mkdir(out) unless Dir.exist?(out)

# Report error keys instead of translated text. Only affects this script's process.
module I18n
  def self.t(key, **) = key.to_s.delete_prefix("billie.backend.")
end

def categorizer_without_rules
  categorizer = Finance::Categorizer.new(user: OpenStruct.new(id: 0))
  categorizer.instance_variable_set(:@learned_rules, {}) # never touch the database
  categorizer
end

categorizer = categorizer_without_rules
cases = JSON.parse(File.read(File.join(root, "categorize-cases.json"))).map do |item|
  amount = BigDecimal(item["amount"])
  {description: item["description"], amount: item["amount"],
   merchant_key: Finance::Categorizer.merchant_key(item["description"]),
   merchant_title: Finance::Categorizer.merchant_key(item["description"])&.titleize,
   category: categorizer.categorize(item["description"], amount)}
end
File.write(File.join(out, "categorize.json"), JSON.pretty_generate(cases) + "\n")

def importer
  importer = Finance::StatementImporter.new(user: OpenStruct.new(id: 0), file: nil, currency: "USD")
  importer.instance_variable_set(:@categorizer, categorizer_without_rules)
  importer
end

cents = ->(decimal) { decimal && (decimal * 100).to_i }
Dir[File.join(root, "statements", "*.csv")].sort.each do |path|
  text = File.read(path, encoding: "UTF-8").delete_prefix("﻿")
  parser = importer
  rows = parser.send(:parse_rows, text)
  balance, balance_on = parser.send(:detected_closing_balance)
  result = {
    rows: rows.map { |row| {bookedOn: row[:booked_on].iso8601, description: row[:description], amountCents: cents.call(row[:amount]), category: row[:category], taxReview: row[:tax_review], excluded: row[:excluded]} },
    closingBalanceCents: cents.call(balance),
    closingBalanceOn: balance_on&.iso8601,
    dateColumnUsed: parser.date_column_used
  }
  File.write(File.join(out, "#{File.basename(path, ".csv")}.json"), JSON.pretty_generate(result) + "\n")
end

errors = JSON.parse(File.read(File.join(root, "statements", "errors.json"))).map do |item|
  code = begin
    importer.send(:parse_rows, item["csv"])
    nil
  rescue Finance::StatementImporter::ImportError => error
    error.message
  rescue CSV::MalformedCSVError
    "csv_unreadable"
  end
  {name: item["name"], code: code}
end
File.write(File.join(out, "errors.json"), JSON.pretty_generate(errors) + "\n")
puts "Wrote #{Dir[File.join(out, "*.json")].length} files to #{out}"
