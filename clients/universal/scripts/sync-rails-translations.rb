# Copies the import error messages from the Rails translations (billie.backend.*)
# into the app, so both say exactly the same thing in every language.
# Run from the repository root:  ruby clients/universal/scripts/sync-rails-translations.rb
require "yaml"
require "json"

CODES = %w[require_csv filename_too_long statement_empty statement_size_limit csv_encoding csv_binary unsupported_currency
  csv_unreadable csv_require_rows csv_duplicate_headers one_column_only csv_required_columns csv_amount_columns statement_row_limit
  csv_extra_values statement_no_transactions row_description_required row_description_length row_currency_mismatch row_invalid_type
  row_debit_credit row_invalid_date row_currency_symbol row_invalid_money row_money_limit statement_duplicate currency_mismatch].freeze
LOCALES = %w[en zh-CN zh-TW ja ko es].freeze

out = LOCALES.to_h do |locale|
  backend = YAML.load_file("config/locales/billie_finance_backend.#{locale}.yml").dig(locale, "billie", "backend")
  [locale, CODES.to_h { |code| [code, backend.fetch(code).gsub(/%\{(\w+)\}/, '{\1}')] }]
end
path = "clients/universal/src/i18n/importErrors.json"
File.write(path, JSON.pretty_generate(out) + "\n")
puts "Wrote #{path} (#{CODES.size} messages × #{LOCALES.size} languages)"
