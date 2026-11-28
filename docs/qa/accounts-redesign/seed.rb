# Synthetic data for the Accounts & Assets redesign preview. Runs only against the isolated
# `accounts_preview_test` database and refuses to touch an existing preview user.
#   RAILS_ENV=test DATABASE_URL=postgres:///accounts_preview_test ACCOUNTS_TEST_PASSWORD=… \
#     bundle exec rails runner docs/qa/accounts-redesign/seed.rb
require "factory_bot_rails"
require "csv"
require "tempfile"
abort "Refusing: not the isolated preview database" unless Rails.env.test? && ActiveRecord::Base.connection_db_config.database == "accounts_preview_test"
password = ENV.fetch("ACCOUNTS_TEST_PASSWORD")
emails = %w[populated many empty].map { |state| "#{state}@example.invalid" }
abort "Use a fresh, isolated preview database" if User.where(email: emails).exists?

def import_statement(user, profile, bank:, number:, kind:, balance:, name:, date:)
  csv = CSV.generate do |rows|
    rows << ["Date", "Description", "Amount", "Balance", "Bank", "Account Number", "Account Type"]
    rows << [date, "Synthetic coffee #{name}", "-5.00", balance, bank, number, kind]
  end
  Tempfile.create(["billie-accounts", ".csv"]) do |file|
    file.write(csv)
    file.flush
    upload = ActionDispatch::Http::UploadedFile.new(tempfile: File.open(file.path), filename: name, type: "text/csv")
    statement = Finance::StatementImporter.new(user: user, file: upload, currency: profile.currency).call
    raise "Synthetic import #{name} did not create an account" unless statement&.bank_account_id
  end
end

today = Date.current
%i[populated many empty].each do |state|
  user = FactoryBot.create(:onboarded_user, email: "#{state}@example.invalid", password: password, password_confirmation: password, nickname: "Alex", locale: "en", time_zone: "Central Time (US & Canada)")
  user.confirm if user.respond_to?(:confirm)
  profile = Finance::Profile.create!(user: user, currency: "USD")
  next if state == :empty
  order = 0
  make = ->(name, type, balance, institution: nil, last4: nil, on: today - 3, currency: "USD", pending: false, archived: false, include: true) do
    order += 1
    Finance::BankAccount.create!(user: user, manual: true, name: name, custom_name: name, account_type: type, bank_name: institution, last4: last4,
      opening_balance: balance || 0, opening_balance_on: (on unless pending), balance_snapshot: !pending && on.present?, balance_pending: pending,
      currency: currency, sort_order: order, archived_at: (Time.current if archived), include_in_net_worth: include)
  end
  if state == :populated
    import_statement(user, profile, bank: "Synthetic Bank", number: "4821", kind: "Checking", balance: "5200.00", name: "synthetic-checking.csv", date: (today - 2).iso8601)
    import_statement(user, profile, bank: "Synthetic Card Co", number: "1005", kind: "Credit Card", balance: "830.00", name: "synthetic-card.csv", date: (today - 6).iso8601)
    make.call("Rainy day savings", "savings", 8200, institution: "Example Credit Union", last4: "3307", on: today - 1)
    make.call("Wallet cash", "cash", 140, on: today - 40)
    make.call("Travel wallet", "cash", 280, currency: "EUR", on: today - 12)
    make.call("Payment app", "payment_app", 62.5, institution: "Example Pay")
    make.call("Brokerage", "investment", 12800, institution: "Example Brokerage", last4: "7710", on: today - 9)
    make.call("Loan to a friend", "receivable", 500, on: nil)
    make.call("Store card", "credit_card", -215.4, institution: "Example Retail", last4: "0031", on: today - 50)
    make.call("Car loan", "loan", -9400, institution: "Example Auto Finance", on: today - 20)
    make.call("Collectibles", "other", nil, pending: true)
    make.call("Old checking", "checking", 0, institution: "Example Savings Bank", last4: "9001", archived: true)
    make.call("Shared expenses", "checking", 310, include: false, on: today - 4)
    ledger = Finance::Ledger.new(user)
    savings = user.finance_bank_accounts.find_by!(custom_name: "Rainy day savings")
    ledger.create(kind: "income", account_id: savings.id, booked_on: today.iso8601, amount: "25", category: "Income", description: "Synthetic interest")
  else
    types = Finance::BankAccount::TYPES
    120.times do |i|
      type = types[i % types.size]
      balance = Finance::Domain.liability?(type) ? -(50 + i * 13.37).round(2) : (200 + i * 41.11).round(2)
      make.call(format("Account %03d", i + 1), type, balance, institution: ("Example Institution #{(i % 7) + 1}" unless (i % 5).zero?),
        last4: (format("%04d", 1000 + i) unless (i % 4).zero?), on: ((today - (i % 60)) unless (i % 6).zero?))
    end
  end
end
puts "Seeded #{emails.join(", ")}"
