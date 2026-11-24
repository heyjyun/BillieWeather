require "bigdecimal"

module Finance
  class Snapshot
    def initialize(user:, start_date: nil, end_date: nil, account_id: nil)
      @user = user
      @start_date = start_date
      @end_date = end_date
      @account_id = account_id
      unless [start_date, end_date].compact.all? { |date| date.is_a?(Date) }
        raise ArgumentError, "Snapshot date bounds must be Date values."
      end
      if start_date && end_date && start_date > end_date
        raise ArgumentError, "Snapshot start date must not be after its end date."
      end
    end

    def to_h
      # Trashed entries never count anywhere; income and expense follow `kind` (finance-domain-spec §2).
      all_transactions = Transaction.live.where(user_id: @user.id)
      all_transactions = all_transactions.where("booked_on >= ?", @start_date) if @start_date
      all_transactions = all_transactions.where("booked_on <= ?", @end_date) if @end_date
      all_transactions = all_transactions.where(bank_account_id: @account_id) if @account_id
      included = all_transactions.included
      profile = Profile.find_by(user_id: @user.id)
      income_by_category = included.income_kind.group(:category).sum(:amount)
      income = income_by_category.values.sum(BigDecimal(0))
      # A refund (positive, kind refund) reduces spending; a card repayment or transfer never counts.
      expenses = -included.expense_kind.sum(:amount)
      monthly = included.order(:booked_on).pluck(:booked_on, :amount, :kind)
        .group_by { |date, _amount, _kind| date.beginning_of_month }
        .map do |month, values|
          incoming = values.sum(BigDecimal(0)) { |_date, amount, kind| Domain::INCOME_KINDS.include?(kind) ? amount : 0 }
          outgoing = -values.sum(BigDecimal(0)) { |_date, amount, kind| Domain::EXPENSE_KINDS.include?(kind) ? amount : 0 }
          {month: month, income: incoming, expenses: outgoing, net: incoming - outgoing}
        end
      categories = included.expense_kind.group(:category).sum(:amount)
        .map { |name, amount| {name: name, amount: -amount} }
        .select { |category| category[:amount].positive? }
        .sort_by { |category| -category[:amount] }

      {
        currency: profile&.currency || "USD",
        current_balance: profile&.current_balance || BigDecimal(0),
        income: income,
        expenses: expenses,
        net: income - expenses,
        transaction_count: all_transactions.count,
        statement_count: (@start_date || @end_date || @account_id) ? all_transactions.distinct.count(:statement_id) : Statement.where(user_id: @user.id).count,
        uncategorized_count: included.where(category: "Uncategorized").count,
        tax_review_count: all_transactions.where(tax_review: true, excluded: false).count,
        excluded_count: all_transactions.where(excluded: true).count,
        transfer_count: all_transactions.where(kind: %w[transfer card_payment], excluded: false).count,
        period_start: included.minimum(:booked_on),
        period_end: included.maximum(:booked_on),
        categories: categories,
        income_categories: income_by_category.filter_map { |name, amount| {name: name, amount: amount} if amount.positive? }
          .sort_by { |category| [-category[:amount], category[:name]] },
        monthly: monthly,
        recent_transactions: all_transactions.recent_first.limit(8).to_a
      }
    end
  end
end
