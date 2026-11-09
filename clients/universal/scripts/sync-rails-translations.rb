# Copies the import messages from the Rails translations into the app, so both say
# exactly the same thing in every language:
#   importErrors.json — billie.backend.* (CSV and PDF errors, PDF review warnings)
#   pdfReview.json    — billie.finance.ui.* text of the website's PDF review page
# Run from the repository root:  ruby clients/universal/scripts/sync-rails-translations.rb
require "yaml"
require "json"

CODES = %w[require_csv filename_too_long statement_empty statement_size_limit csv_encoding csv_binary unsupported_currency
  csv_unreadable csv_require_rows csv_duplicate_headers one_column_only csv_required_columns csv_amount_columns statement_row_limit
  csv_extra_values statement_no_transactions row_description_required row_description_length row_currency_mismatch row_invalid_type
  row_debit_credit row_invalid_date row_currency_symbol row_invalid_money row_money_limit statement_duplicate currency_mismatch
  pdf_filename_limit pdf_empty pdf_size_limit pdf_not_readable pdf_timeout pdf_encrypted pdf_unreadable pdf_page_limit pdf_text_limit
  pdf_no_text pdf_no_rows pdf_candidate_limit pdf_invalid_row_date select_transaction
  pdf_generic_1 pdf_generic_2 pdf_skipped_balance pdf_row_two_dates pdf_row_warning pdf_row_multiple_amounts pdf_row_no_amount
  pdf_row_no_description pdf_row_shortened_description pdf_uncertain_year pdf_blank_pages pdf_warning_limit pdf_amount_currency
  pdf_amount_markers pdf_amount_unsigned pdf_amount_limit pdf_amount_unreadable
  pdf_imported_automatically pdf_review_imported pdf_needs_review pdf_discarded].freeze
# App key => Rails billie.finance.ui key.
REVIEW = {
  "eyebrow" => "you_have_the_final_say", "title" => "review_your_extracted_transactions",
  "noticeTitle" => "check_every_row_against_your_statement",
  "notice" => "pdf_extraction_can_confuse_dates_amounts_running_balances_and_deposit_or_withdra",
  "notes" => "extraction_notes", "rows" => "extracted_rows", "rowsHint" => "nothing_appears_in_your_dashboard_until_you_confirm_this_import",
  "include" => "include", "date" => "date", "description" => "description", "amount" => "signed_amount_currency",
  "includeRow" => "include_row", "rowDate" => "row_date", "rowDescription" => "row_description", "rowAmount" => "row_signed_amount",
  "amountPlaceholder" => "confirm_sign_and_amount", "confirm" => "i_reviewed_the_included_rows_against_my_statement",
  "confirmHint" => "i_checked_the_dates_descriptions_and_signed_amounts_excluded_rows_will_not_be_im",
  "cancel" => "cancel_import", "submit" => "confirm_and_import_transactions"
}.freeze
LOCALES = %w[en zh-CN zh-TW ja ko es].freeze

def message(value)
  value = value["other"] if value.is_a?(Hash) # plural forms: the app shows the general one
  value.gsub(/%\{(\w+)\}/, '{\1}')
end

def write(name, data)
  path = "clients/universal/src/i18n/#{name}"
  File.write(path, JSON.pretty_generate(data) + "\n")
  puts "Wrote #{path} (#{data.values.first.size} messages × #{LOCALES.size} languages)"
end

write("importErrors.json", LOCALES.to_h do |locale|
  backend = YAML.load_file("config/locales/billie_finance_backend.#{locale}.yml").dig(locale, "billie", "backend")
  [locale, CODES.to_h { |code| [code, message(backend.fetch(code))] }]
end)
write("pdfReview.json", LOCALES.to_h do |locale|
  ui = YAML.load_file("config/locales/billie_finance_views.#{locale}.yml").dig(locale, "billie", "finance", "ui")
  [locale, REVIEW.transform_values { |key| message(ui.fetch(key)) }]
end)
