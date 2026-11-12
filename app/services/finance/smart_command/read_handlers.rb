require "bigdecimal"

module Finance
  module SmartCommand
    # Read-only commands. They never write, so they need no confirmation, idempotency or undo; every
    # query is scoped to the signed-in person. Totals count exactly what the dashboard counts
    # (Finance::Snapshot: excluded rows and transfers never count).
    class ReadHandlers
      ACTIONS = %w[app.navigate transactions.find finance.spending finance.income finance.balance categories.list].freeze

      def initialize(user:, urls:, money:, category_label:)
        @user = user
        @urls = urls
        @money = money
        @category_label = category_label
      end

      def prepare(action_id, args)
        label = (action_id == "app.navigate") ? args["page"] : action_id.split(".").last
        [{op: (action_id == "app.navigate") ? "navigate" : "read", target: {kind: "view", id: label, label: label}}]
      end

      def execute(action_id, args)
        case action_id
        when "app.navigate" then navigate(args)
        when "transactions.find" then find(args)
        when "finance.spending" then total(args, sign: -1)
        when "finance.income" then total(args, sign: 1)
        when "finance.balance" then balance
        when "categories.list" then categories
        end
      end

      private

      def message(code, text, vars = {})
        {code: code, message: text, vars: vars}
      end

      def transactions
        Transaction.where(user_id: @user.id)
      end

      def navigate(args)
        page = args["page"]
        url = @urls.fetch(:pages).fetch(page)
        {summary: message("navigated", "Opened {page}.", page: page), data: {redirect: url}}
      end

      def find(args)
        count = TransactionFilter.apply(transactions, args).count
        url = @urls.fetch(:transactions).call(TransactionFilter.page_params(args))
        {summary: message("found", "{count} matching transaction(s).", count: count), data: {count: count, redirect: url}}
      end

      def total(args, sign:)
        rows = TransactionFilter.apply(transactions.included, args).where(sign.negative? ? "amount < 0" : "amount > 0")
        sum = rows.sum(:amount).to_d.abs
        count = rows.count
        if sign.negative?
          {summary: message("spending_total", "Spent {amount} across {count} transaction(s).", amount: @money.call(sum), count: count), data: {total: sum.to_s("F"), count: count}}
        else
          {summary: message("income_total", "Received {amount} across {count} transaction(s).", amount: @money.call(sum), count: count), data: {total: sum.to_s("F"), count: count}}
        end
      end

      # The balance the dashboard shows (Finance::Profile#displayed_balance), read without syncing.
      def balance
        profile = Profile.find_by(user_id: @user.id)
        summary = BalanceSync.summary(user: @user)
        shown = profile&.displayed_balance(summary)
        return {summary: message("balance_unknown", "No balance is known yet.")} if shown.nil?
        if profile.manual_balance?
          {summary: message("balance_manual", "Balance: {amount} (entered by you).", amount: @money.call(shown))}
        else
          known = Array(summary[:accounts]).count { |row| row[:status] == "known" }
          {summary: message("balance_total", "Balance: {amount}, from the latest statement of {count} account(s).", amount: @money.call(shown), count: known)}
        end
      end

      def categories
        names = CustomCategory.names_for(@user)
        {summary: message("categories_list", "{count} categories: {list}", count: names.size, list: names.map { |name| @category_label.call(name) }.join(", ")), data: {count: names.size}}
      end
    end
  end
end
