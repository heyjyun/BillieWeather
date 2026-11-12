require "bigdecimal"

module Finance
  module SmartCommand
    # The rows a command means, always inside one person's own transactions. Search works like the
    # Transactions page (description contains the phrase, case-insensitive), so a command's count
    # and the page it opens agree.
    module TransactionFilter
      MAX_QUERY = 200
      COMPARISONS = {"eq" => "=", "gt" => ">", "gte" => ">=", "lt" => "<", "lte" => "<="}.freeze

      module_function

      def apply(scope, args, category: true)
        query = args["query"]
        if query.is_a?(String) && query.strip.present?
          scope = scope.where("description ILIKE ?", "%#{Transaction.sanitize_sql_like(query.strip.first(MAX_QUERY))}%")
        end
        scope = scope.where(category: args["category"]) if category && args["category"].is_a?(String)
        if (period = args["period"]).is_a?(Hash)
          scope = scope.where("booked_on >= ?", Date.iso8601(period["start"])) if period["start"]
          scope = scope.where("booked_on <= ?", Date.iso8601(period["end"])) if period["end"]
        end
        if (amount = args["amount"]).is_a?(Hash)
          operator = COMPARISONS.fetch(amount["comparator"])
          scope = scope.where("ABS(amount) #{operator} ?", BigDecimal(amount["amountMinor"]) / 100)
        end
        scope
      end

      # The Transactions page's own filters for the same rows (it needs both dates of a range).
      def page_params(args)
        params = {}
        params[:search] = args["query"].strip if args["query"].is_a?(String) && args["query"].strip.present?
        params[:category] = args["category"] if args["category"].is_a?(String)
        if (period = args["period"]).is_a?(Hash)
          params[:start_date] = period["start"] || "#{PlanValidator::YEARS.first}-01-01"
          params[:end_date] = period["end"] || "#{PlanValidator::YEARS.last}-12-31"
        end
        params
      end
    end
  end
end
