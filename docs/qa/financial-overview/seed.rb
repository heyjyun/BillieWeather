require "factory_bot_rails"
abort unless Rails.env.test? && ActiveRecord::Base.connection_db_config.database == "overview_test"
password = ENV.fetch("OVERVIEW_TEST_PASSWORD")
abort "Use a fresh, isolated preview database" if User.where(email: %w[populated@example.invalid empty@example.invalid]).exists?
[:populated, :empty].each do |state|
  user = FactoryBot.create(:onboarded_user, email: "#{state}@example.invalid", password: password, password_confirmation: password, nickname: "Alex", locale: "en", time_zone: "Central Time (US & Canada)")
  user.confirm if user.respond_to?(:confirm)
  Finance::Profile.create!(user: user, currency: "USD")
  next if state == :empty
  account = ->(name, type, balance, currency = "USD") { Finance::BankAccount.create!(user: user, manual: true, name: name, account_type: type, opening_balance: balance, currency: currency) }
  bank = account.call("Everyday checking", "checking", 6400)
  account.call("Rainy day savings", "savings", 8200)
  card = account.call("Everyday card", "credit_card", -430)
  account.call("Long-term savings", "investment", 12800)
  account.call("Travel wallet", "cash", 280, "EUR")
  ledger = Finance::Ledger.new(user)
  today = Time.current.in_time_zone(user.time_zone).to_date
  12.times do |week|
    day = today - (11 - week) * 7
    [["income", "Income", "Studio payroll", 1020 + week * 15], ["expense", "Food & dining", "Neighborhood market", 94 + week * 4], ["expense", ((week < 4) ? "Rent" : "Housing"), "Apartment rent", 340 + (week % 3) * 40], ["expense", "Transport", "City transit", 32], ["expense", "Shopping", "Bookshop", 28 + week * 2]].each_with_index do |(kind, category, desc, amt), i|
      ledger.create(kind: kind, account_id: ((i == 4) ? card : bank).id, booked_on: day - i, amount: amt, category: category, description: desc)
    end
  end
  [["Apartment rent", 1400, 4], ["Internet", 60, 9], ["Transit pass", 75, 12]].each do |name, amount, offset|
    Finance::RecurringRule.create!(user: user, name: name, start_on: today + offset, frequency: "monthly", interval: 1, template: {kind: "expense", account_id: bank.id, amount: amount.to_s, category: "Housing"})
  end
end
