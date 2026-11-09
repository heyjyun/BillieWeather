require "bigdecimal"

module Finance
  # Everything an exported report contains, for one person and one dashboard period.
  # Totals come from the same services the dashboard uses (Snapshot, BalanceSync,
  # AccountOverview), so a downloaded report always matches what was on screen.
  # Every query is scoped to `user`; nothing here accepts a record id from outside.
  class Report
    SHEETS = %w[overview accounts categories transactions].freeze

    Row = Struct.new(:booked_on, :account, :merchant, :description, :category, :amount, :currency,
      :tax_review, :excluded, :counted, keyword_init: true)

    attr_reader :user, :profile, :period, :balance_summary

    # `balance_summary` is the BalanceSync summary the controller already computed for this request.
    def initialize(user:, profile:, period:, balance_summary: nil)
      raise ArgumentError, "profile must belong to user" unless profile.user_id == user.id
      @user = user
      @profile = profile
      @period = period
      @balance_summary = balance_summary || BalanceSync.summary(user: user)
    end

    def currency
      profile.currency
    end

    def snapshot
      @snapshot ||= Snapshot.new(user: user, start_date: period.start_date, end_date: period.end_date).to_h
    end

    def account_overview
      @account_overview ||= AccountOverview.new(summary: balance_summary, profile: profile)
    end

    # The balance shown on the dashboard's balance card; nil when none is known.
    def available_balance
      profile.displayed_balance(balance_summary)
    end

    def balance_as_of
      profile.manual_balance? ? profile.balance_as_of : balance_summary[:as_of_start]
    end

    # Spending by category with each category's share of total expenses (0..1, nil when there are no expenses).
    def categories
      expenses = snapshot[:expenses].to_d
      snapshot[:categories].map do |category|
        category.merge(share: expenses.positive? ? (category[:amount].to_d / expenses) : nil)
      end
    end

    # Every transaction in the period, newest first. Categories are read as stored, so a
    # category the person corrected is exactly what is exported.
    def each_transaction_row
      return enum_for(:each_transaction_row) unless block_given?
      scope = Transaction.where(user_id: user.id).includes(statement: :bank_account).order(booked_on: :desc, id: :desc)
      scope = scope.where("booked_on >= ?", period.start_date) if period.start_date
      scope = scope.where("booked_on <= ?", period.end_date) if period.end_date
      scope.each { |transaction| yield self.class.row_for(transaction, user: user) }
    end

    # One export row for a transaction the caller has already scoped to `user`.
    def self.row_for(transaction, user:)
      raise ArgumentError, "transaction must belong to user" unless transaction.user_id == user.id
      statement = transaction.statement
      account = statement.bank_account if statement.bank_account&.user_id == user.id
      Row.new(
        booked_on: transaction.booked_on,
        account: account&.display_name || statement.filename,
        merchant: Categorizer.merchant_key(transaction.description)&.titleize,
        description: transaction.description,
        category: transaction.category,
        amount: transaction.amount,
        currency: statement.currency,
        tax_review: transaction.tax_review,
        excluded: transaction.excluded,
        counted: !transaction.excluded && transaction.category != "Transfers"
      )
    end

    def filename(extension)
      range = if period.start_date && period.end_date
        "#{period.start_date.iso8601}-to-#{period.end_date.iso8601}"
      else
        "all-time"
      end
      "billieweather-report-#{range}-#{Date.current.iso8601}.#{extension}"
    end
  end
end
