module Finance
  module SmartCommand
    # Checks a plan received from the browser, the way ActionExecutor#admit does in @nlae/core
    # (packages/nl-action-engine/src/executor.ts, validate.ts): shape, protocol, readiness, scope,
    # known action, and every argument against the manifest and the person's own categories.
    class PlanValidator
      PLAN_ID = /\A[A-Za-z0-9_-]{8,100}\z/
      ISO_DATE = /\A\d{4}-\d{2}-\d{2}\z/
      CONTROL_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/
      COMPARATORS = %w[eq gt gte lt lte].freeze
      # Dates the website's own filters accept (Finance::DashboardPeriod).
      YEARS = 1900..2100
      MAX_SAFE_INTEGER = 2**53 - 1

      def initialize(manifest:, product:, tenant:, entities:)
        @manifest = manifest
        @product = product
        @tenant = tenant
        @entities = entities
      end

      # Returns [action definition, arguments with plain values] or raises Rejection.
      def admit(plan, allowed_actions:)
        problem = shape_problem(plan)
        raise Rejection.new("protocol_mismatch", "Unsupported protocol version.") if problem == "protocol"
        raise Rejection.new("malformed_plan", "The plan is malformed (#{problem}).") if problem
        raise Rejection.new("not_ready", "This plan still needs an answer before it can run.") unless plan["status"] == "ready" && plan["intent"].is_a?(Hash)
        scope = plan["scope"]
        unless scope["product"] == @product && scope["tenant"] == @tenant && @product == @manifest.product
          raise Rejection.new("scope_mismatch", "This plan was made for another workspace.")
        end
        action_id = plan.dig("intent", "actionId")
        action = @manifest.action(action_id)
        raise Rejection.new("unknown_action", "That action is not available.") unless action && allowed_actions.include?(action_id)
        args = plan["arguments"].to_h { |name, argument| [name, argument["value"]] }
        issues = argument_issues(action, args)
        raise Rejection.new("invalid_arguments", issues.join("; ")) if issues.any?
        [action, args]
      end

      def shape_problem(plan)
        return "plan must be an object" unless plan.is_a?(Hash)
        return "protocol field" unless plan["protocol"].is_a?(String)
        return "protocol" unless plan["protocol"] == Manifest::PROTOCOL
        return "planId" unless plan["planId"].is_a?(String) && PLAN_ID.match?(plan["planId"])
        return "input" unless plan["input"].is_a?(String) && plan["input"].length <= 2000
        return "scope" unless plan["scope"].is_a?(Hash) && plan["scope"]["product"].is_a?(String) && plan["scope"]["tenant"].is_a?(String)
        return "arguments" unless plan["arguments"].is_a?(Hash) && plan["arguments"].size <= 20
        plan["arguments"].each do |name, argument|
          return "argument #{name.to_s.first(40)}" unless argument.is_a?(Hash) && argument.key?("value")
        end
        intent = plan["intent"]
        return "intent" if !intent.nil? && !(intent.is_a?(Hash) && intent["actionId"].is_a?(String))
        nil
      end

      # A real calendar date in the years the website's filters accept, or nil.
      def self.date(value)
        return unless value.is_a?(String) && ISO_DATE.match?(value)
        date = Date.iso8601(value)
        date if YEARS.cover?(date.year)
      rescue Date::Error
        nil
      end

      private

      def argument_issues(action, args)
        specs = action["params"].index_by { |spec| spec["name"] }
        issues = args.keys.reject { |name| specs.key?(name) }.map { |name| "unknown parameter #{name.to_s.first(40)}" }
        action["params"].each do |spec|
          if args.key?(spec["name"]) && !args[spec["name"]].nil?
            problem = value_problem(spec, args[spec["name"]])
            issues << problem if problem
          elsif spec["required"]
            issues << "#{spec["name"]} is required"
          end
        end
        issues
      end

      def value_problem(spec, value)
        name = spec["name"]
        case spec["type"]
        when "text"
          return "#{name} must be text" unless value.is_a?(String)
          return "#{name} cannot be blank" if value.strip.empty?
          return "#{name} contains control characters" if CONTROL_CHARS.match?(value)
          max = spec["maxLength"] || 500
          "#{name} is longer than #{max} characters" if value.each_char.count > max
        when "enum", "boolean"
          allowed = Array(spec["options"]).map { |option| option["value"] }
          text = (value == true || value == false) ? value.to_s : value
          "#{name} must be one of #{allowed.join(", ")}" unless text.is_a?(String) && allowed.include?(text)
        when "entity"
          return "#{name} must be an id" unless value.is_a?(String) && value.present?
          "#{name} does not exist" unless @entities.call(spec["entityKind"]).include?(value)
        when "number"
          return "#{name} must be a number" unless value.is_a?(Numeric) && value.to_f.finite?
          return "#{name} is too small" if spec["min"] && value < spec["min"]
          "#{name} is too large" if spec["max"] && value > spec["max"]
        when "money"
          return "#{name} must be an amount" unless value.is_a?(Hash) && value.key?("amountMinor")
          minor = value["amountMinor"]
          return "#{name} must be a non-negative amount" unless minor.is_a?(Integer) && minor.between?(0, MAX_SAFE_INTEGER)
          return "#{name} has an unknown comparison" unless COMPARATORS.include?(value["comparator"])
          currency = value["currency"]
          "#{name} has an invalid currency" if !currency.nil? && !(currency.is_a?(String) && currency.match?(/\A[A-Z]{3}\z/))
        when "date"
          "#{name} must be a date" unless self.class.date(value)
        when "dateRange"
          return "#{name} must be a date range" unless value.is_a?(Hash) && value.key?("start") && value.key?("end")
          first, last = value["start"], value["end"]
          return "#{name} is empty" if first.nil? && last.nil?
          return "#{name} has an invalid date" if (!first.nil? && !self.class.date(first)) || (!last.nil? && !self.class.date(last))
          "#{name} ends before it starts" if first && last && first > last
        else
          "#{name} has an unknown type"
        end
      end
    end
  end
end
