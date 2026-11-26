module Finance
  # Reports by kind (finance-domain-spec §2): income = Σ kind income; spending = −Σ kind expense/refund,
  # so refunds net within their category. Grouped by category, account, merchant, project or tag,
  # plus a monthly trend and net worth. Trashed and excluded rows never count.
  # By category, totals roll up the tree (docs/architecture/category-hierarchy.md): top-level
  # categories by default, or one category's children when drilling into it. A node's total is its
  # own entries plus its descendants'; its own entries show as "X (direct)" when it has children.
  class LedgerReport
    DIMENSIONS = %w[category account merchant project tag].freeze

    attr_reader :start_date, :end_date

    def initialize(user:, start_date: nil, end_date: nil)
      @user = user
      @start_date = start_date
      @end_date = end_date
    end

    def counted
      scope = Transaction.included.where(user_id: @user.id)
      scope = scope.where("booked_on >= ?", @start_date) if @start_date
      scope = scope.where("booked_on <= ?", @end_date) if @end_date
      scope
    end

    def income_total = counted.income_kind.sum(:amount)
    def expense_total = -counted.expense_kind.sum(:amount)

    def expense_by_category = sorted(counted.expense_kind.group(:category).sum(:amount).transform_values(&:-@))
    def income_by_category = sorted(counted.income_kind.group(:category).sum(:amount))

    # {label => {income:, expense:}} for one dimension. Rows without a value are grouped under nil.
    # Category rows also carry `direct:` (the node's own entries) and `drill:` (it has children).
    def by(dimension, node: nil)
      raise ArgumentError, "unknown dimension" unless DIMENSIONS.include?(dimension)
      return by_category(node) if dimension == "category"
      key, names = case dimension
      when "account" then [:bank_account_id, BankAccount.where(user_id: @user.id).to_h { |a| [a.id, a.display_name] }]
      when "merchant" then [:merchant_id, Merchant.where(user_id: @user.id).pluck(:id, :name).to_h]
      when "project" then [:project_id, Project.where(user_id: @user.id).pluck(:id, :name).to_h]
      when "tag" then ["finance_transaction_tags.tag_id", Tag.where(user_id: @user.id).pluck(:id, :name).to_h]
      end
      scope = (dimension == "tag") ? counted.joins(:transaction_tags) : counted
      rows = Hash.new { |hash, label| hash[label] = {income: BigDecimal(0), expense: BigDecimal(0)} }
      scope.group(key, :kind).sum(:amount).each do |(id, kind), amount|
        label = id && names[id]
        if Domain.counts_as(kind) == "income" then rows[label][:income] += amount else rows[label][:expense] -= amount end
      end
      rows.sort_by { |label, row| [-row[:expense], -row[:income], label.to_s] }.to_h
    end

    def monthly
      counted.order(:booked_on).pluck(:booked_on, :amount, :kind).group_by { |date, _, _| date.beginning_of_month }.map do |month, values|
        income = values.sum(BigDecimal(0)) { |_, amount, kind| (Domain.counts_as(kind) == "income") ? amount : 0 }
        expense = -values.sum(BigDecimal(0)) { |_, amount, kind| (Domain.counts_as(kind) == "expense") ? amount : 0 }
        {month: month, income: income, expense: expense, net: income - expense}
      end
    end

    def net_worth
      BankAccount.net_worth_for(@user, as_of: @end_date)
    end

    private

    def tree
      @tree ||= CategoryTree.new(@user)
    end

    def by_category(node = nil)
      focus = node && tree.node(node)
      rows = Hash.new { |hash, label| hash[label] = {income: BigDecimal(0), expense: BigDecimal(0), direct: false, drill: false} }
      counted.group(:category, :kind).sum(:amount).each do |(category, kind), amount|
        label, direct = if focus
          path = tree.path_names(category)
          index = path.index(focus.name)
          next unless index
          (index == path.length - 1) ? [focus.name, focus.children.any?] : [path[index + 1], false]
        else
          [tree.root_of(category), false]
        end
        row = rows[label]
        row[:direct] = direct
        row[:drill] = !direct && tree.node(label)&.children&.any? || false
        if Domain.counts_as(kind) == "income" then row[:income] += amount else row[:expense] -= amount end
      end
      rows.sort_by { |label, row| [row[:direct] ? 1 : 0, -row[:expense], -row[:income], label.to_s] }.to_h
    end

    def sorted(hash)
      hash.select { |_name, amount| amount.nonzero? }.sort_by { |name, amount| [-amount, name.to_s] }.to_h
    end
  end
end
