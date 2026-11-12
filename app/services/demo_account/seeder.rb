require "digest"

module DemoAccount
  # Creates the Example Account (or reuses it) and rebuilds its finances from scratch.
  #
  # Every row is generated here from made-up merchants and a fixed random seed, dated relative
  # to today so the dashboard, forecasts and tax pages always have recent data. Nothing is read
  # from, copied from or compared with any other account. Running it again is the reset: it
  # deletes only the demo user's finance rows (Finance::DataDeletion, scoped to that one id)
  # and writes a fresh copy.
  #
  #   bin/rails billie:demo:seed
  class Seeder
    MONTHS = 6
    SEED = 20_260_101
    TIME_ZONE = "America/Chicago"

    ACCOUNTS = {
      checking: {bank_name: "Northwind Community Bank", name: "Checking", last4: "4821", kind: "cash", opening: "4200.00"},
      savings: {bank_name: "Northwind Community Bank", name: "Savings", last4: "7350", kind: "cash", opening: "8000.00"},
      card: {bank_name: "Harbor Card", name: "Credit account", last4: "1094", kind: "credit", opening: "-640.18"}
    }.freeze

    CUSTOM_CATEGORIES = %w[Pets Travel].freeze

    # Category corrections the demo "person" made once; later transactions follow them.
    CORRECTIONS = [
      ["PAWS & CLAWS PET SUPPLY", "Pets"],
      ["COWORK HUB DAY PASS", "Business"],
      ["BLUE DOOR CAFE", "Food & dining"],
      ["HOTEL ALFAMA LISBOA", "Travel"]
    ].freeze

    def self.call(today: nil)
      new(today: today).call
    end

    def initialize(today: nil)
      @today = today || Time.current.in_time_zone(TIME_ZONE).to_date
      @random = Random.new(SEED)
    end

    # Returns the demo user.
    def call
      user = find_or_create_user!
      raise "refusing to seed a non-demo account" unless user.demo_account?

      User.transaction do
        User.find(user.id).with_lock do
          Finance::DataDeletion.new(user: user).delete_records!
          build_finances!(user)
        end
      end
      Finance::DataDeletion.clear_cached_forecasts(user.id)
      Finance::BalanceSync.call(user: user)
      # Insights last, so they are newer than every record and the pages do not call them stale.
      I18n.with_locale(:en) { Finance::InsightGenerator.new(user: user, provider: "rules", kind: "general").call }
      Finance::Insight.create!(user: user, source: "rules", kind: "tax", content: tax_explanation, generated_at: Time.current)
      user
    end

    private

    def find_or_create_user!
      existing = DemoAccount.user
      return existing if existing

      User.transaction do
        # A random password nobody ever sees; User#valid_password? refuses it anyway.
        password = SecureRandom.base58(64)
        user = User.new(email: DemoAccount::EMAIL, nickname: DemoAccount::NICKNAME, password: password,
          password_confirmation: password, usage_region: "US", time_zone: "Central Time (US & Canada)")
        user.demo_identity_allowed = true
        user.save!
        user.create_default_team
        user
      end
    end

    def build_finances!(user)
      CUSTOM_CATEGORIES.each { |name| Finance::CustomCategory.create!(user: user, name: name) }
      Finance::Profile.create!(user: user, currency: "USD", tax_country: "United States", tax_profile: "self_employed",
        cash_on_hand: BigDecimal("120.00"), cash_on_hand_on: @today)
      accounts = ACCOUNTS.to_h do |key, attributes|
        account = Finance::BankAccount.create!(user: user, identity_key: digest("account", key),
          **attributes.except(:opening))
        [key, account]
      end
      balances = ACCOUNTS.transform_values { |attributes| BigDecimal(attributes[:opening]) }
      card_owed_last_month = -balances[:card]

      months.each do |month_start, month_end|
        rows = month_rows(month_start, month_end, card_owed_last_month)
        rows.each do |key, entries|
          next if entries.empty?
          balances[key] += entries.sum(BigDecimal(0)) { |entry| entry[:amount] }
          # A credit statement prints what is owed; spending is negative, so owed is the opposite.
          closing = (key == :card) ? -balances[key] : balances[key]
          create_statement!(user, accounts[key], key, month_start, month_end, entries, closing)
        end
        card_owed_last_month = -balances[:card]
      end
      CORRECTIONS.each do |description, category|
        Finance::MerchantRule.create!(user: user, merchant_key: Finance::Categorizer.merchant_key(description), income: false, category: category)
      end
    end

    # [first day, last day] of each statement period, oldest first. The current month runs to yesterday.
    def months
      current = @today.beginning_of_month
      (MONTHS - 1).downto(0).filter_map do |offset|
        start = current << offset
        finish = offset.zero? ? @today - 1 : start.end_of_month
        [start, finish] if finish >= start
      end
    end

    def month_rows(start, finish, card_owed)
      rows = {checking: [], savings: [], card: []}
      add = ->(key, day, description, amount, category, tax_review: false) do
        date = start + (day - 1)
        rows[key] << {booked_on: date, description: description, amount: BigDecimal(amount.to_s).round(2), category: category, tax_review: tax_review} if date <= finish
      end
      index = months.index { |month| month.first == start }

      add.call(:checking, 1, "MAPLE COURT APARTMENTS RENT", -1650, "Housing")
      add.call(:checking, 1, "ACME ANALYTICS PAYROLL DIRECT DEP", 2310.55, "Income")
      add.call(:checking, 15, "ACME ANALYTICS PAYROLL DIRECT DEP", 2310.55, "Income")
      add.call(:checking, 10, "UPWORK ESCROW PAYOUT DESIGN PROJECT", money(650, 1400), "Income", tax_review: true)
      add.call(:checking, 2, "METRO TRANSIT MONTHLY PASS", -98, "Transport")
      add.call(:checking, 5, "CITY POWER & LIGHT", -money(78, 132), "Utilities")
      add.call(:checking, 12, "FIBERNET INTERNET", -64.99, "Utilities")
      add.call(:checking, 20, "BRIGHTWAVE MOBILE", -45, "Utilities")
      add.call(:checking, 14, "ADOBE CREATIVE CLOUD", -59.99, "Business", tax_review: true)
      add.call(:checking, 18, "COWORK HUB DAY PASS", -25, "Business", tax_review: true) if index.even?
      [3, 10, 17, 24].each { |day| add.call(:checking, day, "GREENLEAF MARKET #214", -money(58, 142), "Food & dining") }
      [6, 19].each { |day| add.call(:checking, day, "BLUE DOOR CAFE", -money(12, 38), "Food & dining") }
      add.call(:checking, 8, "NORTHSIDE PHARMACY", -money(9, 45), "Health") if index.odd?
      add.call(:checking, 26, "PAWS & CLAWS PET SUPPLY", -money(28, 64), "Pets")
      add.call(:checking, 16, "TRANSFER TO SAVINGS ••7350", -500, "Transfers")
      add.call(:savings, 16, "TRANSFER FROM CHECKING ••4821", 500, "Transfers")
      if card_owed.positive?
        add.call(:checking, 22, "HARBOR CARD AUTOPAY", -card_owed, "Transfers")
        add.call(:card, 22, "PAYMENT THANK YOU", card_owed, "Transfers")
      end
      add.call(:savings, 28, "INTEREST PAYMENT", money(22, 26), "Income", tax_review: true)

      add.call(:card, 4, "PAPERLEAF BOOKS", -money(14, 48), "Shopping")
      add.call(:card, 9, "STREAMFLIX SUBSCRIPTION", -15.49, "Shopping")
      add.call(:card, 13, "ONLINE MARKETPLACE ORDER", -money(35, 160), "Shopping")
      add.call(:card, 21, "RIDESHARE TRIP", -money(11, 29), "Transport")
      add.call(:card, 25, "SUNSET THAI KITCHEN", -money(24, 58), "Food & dining")

      # Foreign-currency spending, shown in the profile currency (USD) at the rate in the description.
      if index == MONTHS - 4
        add.call(:card, 7, "HOTEL ALFAMA LISBOA · EUR 412.00 @ 1.0850", -447.02, "Travel")
        add.call(:card, 8, "CARRIS TRAM LISBOA · EUR 3.10 @ 1.0850", -3.36, "Transport")
        add.call(:card, 8, "CAFE A BRASILEIRA · EUR 18.40 @ 1.0850", -19.96, "Food & dining")
        add.call(:card, 9, "FOREIGN TRANSACTION FEE", -14.11, "Travel")
      end
      if index == MONTHS - 2
        add.call(:card, 11, "TOKYO METRO · JPY 1,200 @ 0.0067", -8.04, "Transport")
        add.call(:card, 11, "KISSA HANA TOKYO · JPY 2,450 @ 0.0067", -16.42, "Food & dining")
      end
      # Left for the visitor to see what still needs a category.
      add.call(:checking, 23, "SQ *RIVERSIDE MKT", -23.50, "Uncategorized") if index == MONTHS - 1
      add.call(:card, 3, "AMZN MKTP US*2K4", -31.87, "Uncategorized") if index == MONTHS - 1

      rows.transform_values { |entries| entries.sort_by { |entry| [entry[:booked_on], entry[:description]] } }
    end

    def create_statement!(user, account, key, start, finish, entries, closing)
      statement = Finance::Statement.create!(user: user, bank_account: account, currency: "USD",
        filename: "example-#{account.bank_name.parameterize}-#{account.last4}-#{start.strftime("%Y-%m")}.csv",
        sha256: digest("statement", key, start.iso8601), status: "imported", transaction_count: entries.size,
        closing_balance: closing, closing_balance_on: finish, balance_observed_on: finish)
      now = Time.current
      Finance::Transaction.insert_all!(entries.map do |entry|
        entry.merge(user_id: user.id, statement_id: statement.id, excluded: false, created_at: now, updated_at: now)
      end)
    end

    def money(low, high)
      (low + @random.rand * (high - low)).round(2)
    end

    def digest(*parts)
      Digest::SHA256.hexdigest(["billieweather-example-account", *parts].join(":"))
    end

    def tax_explanation
      {
        "summary" => "Example explanation for the Example Account, built from synthetic data. Over the last six months this " \
          "account received twice-monthly payroll deposits, freelance payouts from a marketplace, and a little savings " \
          "interest. Several business-related expenses were flagged for review.",
        "tax_preparation" => [
          {"title" => "Freelance payouts", "body" => "The UPWORK ESCROW PAYOUT deposits are flagged for tax review. Self-employment " \
            "income is usually reported separately from wages, so keep the platform's year-end income form with these records."},
          {"title" => "Business expenses", "body" => "ADOBE CREATIVE CLOUD and COWORK HUB charges are categorized as Business and " \
            "flagged. Keep receipts that show the business purpose; whether they count depends on your situation."},
          {"title" => "Transfers are not income", "body" => "Moves between checking, savings and the Harbor Card are categorized as " \
            "Transfers, so they stay out of income and spending totals."},
          {"title" => "Interest income", "body" => "Savings interest is small but flagged, because banks usually send a year-end " \
            "interest statement that should match these deposits."},
          {"title" => "Foreign-currency purchases", "body" => "Travel purchases in EUR and JPY appear in USD at the rate shown in each " \
            "description. They are personal travel here, so they are not flagged."}
        ],
        "questions" => [
          {"title" => "Were any freelance payouts reimbursements?", "body" => "Reimbursed costs and earned income are recorded differently; " \
            "a tax professional can confirm how to treat them."},
          {"title" => "Is the coworking space used only for work?", "body" => "Mixed personal and business use can change what may be claimed."}
        ],
        "limitations" => [
          "This is an example built from synthetic data, not tax advice.",
          "BillieWeather does not calculate tax owed or check jurisdiction-specific rules."
        ]
      }
    end
  end
end
