require "bigdecimal"

module Finance
  # Where the money goes: the numbers behind the spending charts on the dashboard and the
  # Categories page. Only counted spending (amount < 0, not excluded, not Transfers) is used.
  # The apps compute the same thing in packages/finance-core/src/spending.ts.
  #
  # Colors follow the category, never its rank in the current view: the SLOTS biggest
  # all-time spending categories (Uncategorized aside) each own one chart color, the same on
  # every page and in every date range. Everything else is drawn as "Other".
  class SpendingBreakdown
    SLOTS = 7
    OTHER = "__other"
    UNCATEGORIZED = "Uncategorized"
    MERCHANT_LIMIT = 5

    def initialize(user:)
      @user = user
    end

    # Category names that own a color, in slot order.
    def palette
      @palette ||= totals_by_category(spending)
        .reject { |name, _amount| name == UNCATEGORIZED }
        .sort_by { |name, amount| [-amount, name] }
        .first(SLOTS).map(&:first)
    end

    # 0..SLOTS-1 for a category with its own color, otherwise "other" or "uncategorized".
    def tone(name)
      return "uncategorized" if name == UNCATEGORIZED
      palette.index(name) || "other"
    end

    # The split of spending in a date range: colored categories biggest first, then Other
    # (with the categories it holds), then Uncategorized.
    def mix(start_date: nil, end_date: nil)
      totals = totals_by_category(within(spending, start_date, end_date))
      total = totals.values.sum(BigDecimal(0))
      named = totals.select { |name, _amount| palette.include?(name) }
        .sort_by { |name, amount| [-amount, name] }
        .map { |name, amount| part(name, tone(name), amount, total) }
      rest = totals.reject { |name, _amount| palette.include?(name) || name == UNCATEGORIZED }
      if rest.any?
        members = rest.sort_by { |name, amount| [-amount, name] }.map(&:first)
        named << part(OTHER, "other", rest.values.sum(BigDecimal(0)), total).merge(members: members)
      end
      named << part(UNCATEGORIZED, "uncategorized", totals[UNCATEGORIZED], total) if totals[UNCATEGORIZED]
      {total: total, parts: named}
    end

    # Spending per calendar month for the latest `months` months that have counted
    # transactions, split by category. Segments keep one stacking order in every month
    # (slot order, then Other, then Uncategorized) so a color sits in the same place.
    def monthly(months: 6)
      window = month_window(months)
      return [] if window.empty?
      sums = Hash.new { |hash, key| hash[key] = Hash.new(BigDecimal(0)) }
      within(spending, window.first, window.last.end_of_month).pluck(:booked_on, :category, :amount).each do |date, category, amount|
        key = palette.include?(category) ? category : ((category == UNCATEGORIZED) ? UNCATEGORIZED : OTHER)
        sums[date.beginning_of_month][key] -= amount
      end
      order = palette + [OTHER, UNCATEGORIZED]
      window.map do |month|
        segments = order.filter_map do |key|
          amount = sums[month][key]
          {key: key, tone: (key == OTHER) ? "other" : tone(key), amount: amount} if amount.positive?
        end
        {month: month, total: segments.sum(BigDecimal(0)) { |segment| segment[:amount] }, segments: segments}
      end
    end

    # One category over time: spending in each of the latest `months` months, the average
    # month (counted from the first month in the window this category was used), and the
    # latest month.
    def trend(name, months: 12)
      window = month_window(months)
      return {months: [], average: nil, latest: nil} if window.empty?
      sums = Hash.new(BigDecimal(0))
      within(spending.where(category: name), window.first, window.last.end_of_month).pluck(:booked_on, :amount).each do |date, amount|
        sums[date.beginning_of_month] -= amount
      end
      rows = window.map { |month| {month: month, amount: sums[month]} }
      active = rows.drop_while { |row| row[:amount].zero? }
      average = active.any? ? (active.sum(BigDecimal(0)) { |row| row[:amount] } / active.size).round(2) : nil
      {months: rows, average: average, latest: rows.last}
    end

    # Where a category's money went, biggest merchants first.
    def top_merchants(name, limit: MERCHANT_LIMIT)
      totals = Hash.new { |hash, key| hash[key] = {amount: BigDecimal(0), count: 0} }
      spending.where(category: name).pluck(:description, :amount).each do |description, amount|
        key = Categorizer.merchant_key(description) || description.to_s.strip.downcase
        totals[key][:amount] -= amount
        totals[key][:count] += 1
      end
      totals.sort_by { |key, row| [-row[:amount], key] }.first(limit)
        .map { |key, row| {name: self.class.merchant_name(key), amount: row[:amount], count: row[:count]} }
    end

    # "starbucks store" -> "Starbucks Store"; the same in finance-core's merchantName.
    def self.merchant_name(key)
      key.split(" ").map { |word| word[0].upcase + word[1..] }.join(" ")
    end

    private

    def spending
      Transaction.where(user_id: @user.id).included.where("amount < 0")
    end

    def within(scope, start_date, end_date)
      scope = scope.where("booked_on >= ?", start_date) if start_date
      scope = scope.where("booked_on <= ?", end_date) if end_date
      scope
    end

    def totals_by_category(scope)
      scope.group(:category).sum(:amount).transform_values { |amount| -amount }.select { |_name, amount| amount.positive? }
    end

    def part(key, tone, amount, total)
      {key: key, name: (key == OTHER) ? nil : key, tone: tone, amount: amount, share: total.positive? ? (amount / total).to_f : nil}
    end

    # Consecutive months ending with the latest month that has counted transactions.
    def month_window(months)
      latest = Transaction.where(user_id: @user.id).included.maximum(:booked_on)
      return [] unless latest
      last = latest.beginning_of_month
      (0...months).map { |offset| last << (months - 1 - offset) }
    end
  end
end
