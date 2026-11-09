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

# PDF statements: pdf/*.txt is the text of each page (pages separated by form feeds),
# which is what pdf-reader hands to PdfStatementExtractor. Warnings keep their
# variables so the TypeScript port can be compared message by message.
module I18n
  def self.t(key, **vars)
    code = key.to_s.delete_prefix("billie.backend.")
    vars.empty? ? code : [code, vars.transform_values { |value| value.is_a?(Date) ? value.iso8601 : value }]
  end
end

def pdf_extract(pages)
  extractor = Finance::PdfStatementExtractor.new(user: OpenStruct.new(id: 0), file: nil, currency: "USD")
  raise Finance::StatementImporter::ImportError, I18n.t("billie.backend.pdf_no_text") if pages.all?(&:blank?)
  rows, warnings = extractor.send(:extract_rows, pages.join("\n"))
  raise Finance::StatementImporter::ImportError, I18n.t("billie.backend.pdf_no_rows") if rows.empty?
  warnings << I18n.t("billie.backend.pdf_blank_pages") if pages.any?(&:blank?)
  [extractor, rows, warnings.uniq]
end

def pdf_warning(warning)
  index = Finance::PdfStatementExtractor::GENERIC_NOTICES.index(warning)
  return {code: "pdf_generic_#{index + 1}", vars: {}} if index
  code, vars = Array(warning)
  # "Row N: <amount problem>" is one message in Rails; the port keeps the inner code.
  return {code: Array(vars[:warning]).first, vars: {row: vars[:row]}.merge(Array(vars[:warning])[1] || {})} if code == "pdf_row_warning"
  {code: code, vars: vars || {}}
end

pdf_out = File.join(out, "pdf")
Dir.mkdir(pdf_out) unless Dir.exist?(pdf_out)
Dir[File.join(root, "pdf", "*.txt")].sort.each do |path|
  extractor, rows, warnings = pdf_extract(File.read(path, encoding: "UTF-8").split("\f", -1))
  draft = Finance::StatementDraft.new(rows: rows, warnings: warnings.map { |w| w.is_a?(Array) ? w.first : w })
  result = {
    today: Date.current.iso8601,
    rows: rows.map { |row| {bookedOn: row["booked_on"], description: row["description"], amount: row["amount"]} },
    warnings: warnings.map { |warning| pdf_warning(warning) },
    closingBalanceCents: cents.call(extractor.instance_variable_get(:@closing_balance)),
    closingBalanceOn: extractor.instance_variable_get(:@closing_balance_on)&.iso8601,
    autoImportable: draft.auto_importable?
  }
  File.write(File.join(pdf_out, "#{File.basename(path, ".txt")}.json"), JSON.pretty_generate(result) + "\n")
end
pdf_errors = JSON.parse(File.read(File.join(root, "pdf", "errors.json"))).map do |item|
  code = begin
    pdf_extract(item["pages"])
    nil
  rescue Finance::StatementImporter::ImportError => error
    error.message.start_with?("[") ? error.message[/\w+/] : error.message # drop the variables
  end
  {name: item["name"], code: code}
end
File.write(File.join(pdf_out, "errors.json"), JSON.pretty_generate({today: Date.current.iso8601, cases: pdf_errors}) + "\n")

puts "Wrote #{Dir[File.join(out, "*.json")].length} files to #{out}"
