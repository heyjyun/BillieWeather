require "json"
require "bigdecimal"

module Finance
  # The shared finance domain (docs/architecture/finance-domain-spec.md). Every enum and rule is read
  # from packages/finance-core/schema/financial-schema.json, the same file the TypeScript clients
  # import (packages/finance-core/src/ledger/domain.ts), so both sides interpret a transaction alike.
  # Contract tests: test/services/finance/domain_contract_test.rb.
  module Domain
    SCHEMA_PATH = Rails.root.join("packages/finance-core/schema/financial-schema.json")
    SCHEMA = JSON.parse(File.read(SCHEMA_PATH)).freeze

    VERSION = SCHEMA.fetch("version")
    ACCOUNT_TYPES = SCHEMA.fetch("account_types").keys.freeze
    TRANSACTION_KINDS = SCHEMA.fetch("transaction_kinds").keys.freeze
    LINK_TYPES = SCHEMA.fetch("link_types").keys.freeze
    LINK_STATUSES = SCHEMA.fetch("link_statuses").freeze
    DECIDED_BY = SCHEMA.fetch("decided_by").freeze
    CATEGORY_KINDS = SCHEMA.fetch("category_kinds").freeze
    CATEGORY_SOURCES = SCHEMA.fetch("category_sources").freeze
    ENTRY_ORIGINS = SCHEMA.fetch("entry_origins").freeze
    LOCKED_FIELDS = SCHEMA.fetch("locked_fields").freeze
    AUDIT_ACTORS = SCHEMA.fetch("audit_actor_kinds").freeze
    AUDIT_ACTIONS = SCHEMA.fetch("audit_actions").freeze
    BUDGET_PERIODS = SCHEMA.fetch("budget_periods").freeze
    FREQUENCIES = SCHEMA.fetch("recurrence_frequencies").freeze
    COUNTED_KINDS = TRANSACTION_KINDS.select { |kind| SCHEMA.dig("transaction_kinds", kind, "counts") }.freeze
    INCOME_KINDS = TRANSACTION_KINDS.select { |kind| SCHEMA.dig("transaction_kinds", kind, "counts") == "income" }.freeze
    EXPENSE_KINDS = TRANSACTION_KINDS.select { |kind| SCHEMA.dig("transaction_kinds", kind, "counts") == "expense" }.freeze
    LIABILITY_TYPES = ACCOUNT_TYPES.select { |type| SCHEMA.dig("account_types", type, "class") == "liability" }.freeze

    inference = SCHEMA.fetch("kind_inference")
    # JavaScript's "iu" flags: case-insensitive; \W is Unicode-aware in Ruby on UTF-8 strings.
    CARD_PAYMENT = Regexp.new(inference.fetch("card_payment_patterns").join("|"), Regexp::IGNORECASE)
    # Money OUT of an asset account is a card payment only with these stricter patterns ("COMCAST AUTOPAY" stays an expense).
    CARD_PAYMENT_OUT = Regexp.new(inference.fetch("card_payment_outflow_patterns").join("|"), Regexp::IGNORECASE)
    CARD_STATEMENT_PAYMENT = /\bpayment\W+thank\W+you\b|\bpayment\W+received\b/i
    REFUND = Regexp.new(inference.fetch("refund_patterns").join("|"), Regexp::IGNORECASE)
    TRANSFER = Regexp.new(inference.fetch("transfer_patterns").join("|"), Regexp::IGNORECASE)

    module_function

    def account_class(type)
      SCHEMA.dig("account_types", type.to_s, "class") || "asset"
    end

    def liability?(type)
      LIABILITY_TYPES.include?(type.to_s)
    end

    def account_type_from_legacy(kind, side = "web")
      mapped = SCHEMA.dig("legacy_account_kinds", side.to_s, kind.to_s)
      ACCOUNT_TYPES.include?(mapped) ? mapped : "other"
    end

    # "income", "expense" or nil (kinds that never count in income/expense totals).
    def counts_as(kind)
      SCHEMA.dig("transaction_kinds", kind.to_s, "counts")
    end

    def category_kind_for(kind)
      SCHEMA.dig("transaction_kinds", kind.to_s, "category_kind")
    end

    # The stored (signed) amount for a manual entry typed as a positive number.
    def signed_amount(kind, positive)
      case SCHEMA.dig("transaction_kinds", kind.to_s, "sign")
      when "out" then -positive.abs
      when "in" then positive.abs
      else positive
      end
    end

    def transfer_kind(to_type)
      liability?(to_type) ? "card_payment" : "transfer"
    end

    # The economic kind of an IMPORTED row (packages/finance-core fixtures/kind-cases.json).
    def infer_kind(amount:, account_type:, description:)
      amount = BigDecimal(amount.to_s)
      text = description.to_s
      return "ignored" if amount.zero?
      if account_type && liability?(account_type)
        return CARD_PAYMENT.match?(text) ? "card_payment" : "refund" if amount.positive?
        return TRANSFER.match?(text) ? "transfer" : "expense"
      end
      if amount.positive?
        return "card_payment" if CARD_STATEMENT_PAYMENT.match?(text)
        return "refund" if REFUND.match?(text)
        return "transfer" if TRANSFER.match?(text)
        return "income"
      end
      return "card_payment" if CARD_PAYMENT_OUT.match?(text)
      return "transfer" if TRANSFER.match?(text)
      "expense"
    end

    # The kind stored for an imported row once its category is decided (person, file, rule, keyword):
    # financial-schema.json kind_inference.categorized_rule; cases in kind-cases.json "categorized".
    # With `transfer_categories` (a person's whole transfer subtree, docs/architecture/category-hierarchy.md)
    # the category kinds come only from the two lists; without it the old built-in names count too.
    def kind_for_categorized(amount:, account_type:, description:, category:, income_categories: [], transfer_categories: nil)
      amount = BigDecimal(amount.to_s)
      inferred = infer_kind(amount: amount, account_type: account_type, description: description)
      legacy = transfer_categories.nil?
      transfer = legacy ? category == "Transfers" : transfer_categories.include?(category)
      return (inferred == "card_payment") ? "card_payment" : "transfer" if transfer
      return "income" if (legacy && category == "Income") || Array(income_categories).include?(category)
      return "ignored" if amount.zero?
      return "expense" if amount.negative?
      return (inferred == "income") ? "income" : "refund" if category == "Uncategorized"
      "refund"
    end

    # The kind an existing row gets when the column is added: reproduces the old totals exactly.
    def legacy_kind(amount:, category:)
      return "transfer" if category == "Transfers"
      BigDecimal(amount.to_s).positive? ? "income" : "expense"
    end

    # The kind a row counted as income probably has instead (refund, card payment), or nil.
    def suspect_income(kind:, amount:, account_type:, description:)
      return nil unless kind.to_s == "income"
      inferred = infer_kind(amount: amount, account_type: account_type, description: description)
      (inferred == "income") ? nil : inferred
    end

    # Totals over plain hashes {occurred_on:, amount:, kind:, category:, excluded:, deleted:}.
    def totals(entries, from: nil, to: nil)
      result = {income: BigDecimal(0), expense: BigDecimal(0), expense_by_category: Hash.new(BigDecimal(0)), income_by_category: Hash.new(BigDecimal(0))}
      entries.each do |entry|
        next if entry[:deleted] || entry[:excluded] || counts_as(entry[:kind]).nil?
        next if from && entry[:occurred_on] < from
        next if to && entry[:occurred_on] > to
        amount = BigDecimal(entry[:amount].to_s)
        if counts_as(entry[:kind]) == "income"
          result[:income] += amount
          result[:income_by_category][entry[:category]] += amount
        else
          result[:expense] -= amount
          result[:expense_by_category][entry[:category]] -= amount
        end
      end
      result[:net] = result[:income] - result[:expense]
      result
    end

    def refundable(expense_amount, refunded)
      [expense_amount.abs - Array(refunded).sum(BigDecimal(0)) { |value| BigDecimal(value.to_s).abs }, 0].max
    end

    # Validation codes shared with packages/finance-core entryProblems.
    def entry_problems(kind:, amount:, occurred_on:, account_id:, to_account_id: nil, category_kind: nil, refund_of: :unset)
      return ["kind_invalid"] unless TRANSACTION_KINDS.include?(kind.to_s)
      problems = []
      value = (amount.nil? || amount.to_s.strip.empty?) ? nil : BigDecimal(amount.to_s, exception: false)
      if value.nil? || !value.finite?
        problems << "amount_required"
      else
        problems << "amount_precision" if value != value.round(2)
        problems << "amount_too_large" if value.abs >= 10**13
        problems << "amount_zero" if value.zero? && kind.to_s != "adjustment"
      end
      date = if occurred_on.is_a?(Date)
        occurred_on
      else
        begin
          Date.iso8601(occurred_on.to_s)
        rescue
          nil
        end
      end
      problems << "date_invalid" unless date
      problems << "account_required" if account_id.blank?
      if %w[transfer card_payment].include?(kind.to_s)
        if to_account_id.blank?
          problems << "account_required"
        elsif to_account_id.to_s == account_id.to_s
          problems << "accounts_same"
        end
      end
      wanted = category_kind_for(kind)
      problems << "category_kind" if wanted && category_kind && !%w[any transfer].include?(category_kind.to_s) && category_kind.to_s != wanted
      if kind.to_s == "refund" && refund_of != :unset
        if refund_of.nil?
          problems << "refund_target_required"
        elsif value && value.abs > refundable(refund_of[:amount], [refund_of[:refunded]])
          problems << "refund_too_large"
        end
      end
      problems.uniq
    end

    def next_occurrence(anchor, from, frequency, interval = 1)
      step = [interval.to_i, 1].max
      anchor = anchor.is_a?(Date) ? anchor : Date.iso8601(anchor.to_s)
      from = from.is_a?(Date) ? from : Date.iso8601(from.to_s)
      case frequency.to_s
      when "daily", "weekly"
        days = ((frequency.to_s == "daily") ? 1 : 7) * step
        n = [((from - anchor).to_i / days) + 1, 1].max
        anchor + n * days
      else
        months = ((frequency.to_s == "monthly") ? 1 : 12) * step
        n = 1
        loop do
          candidate = anchor >> (n * months) # Ruby clamps to the month's last day
          candidate = Date.new(candidate.year, candidate.month, [anchor.day, Date.new(candidate.year, candidate.month, -1).day].min)
          return candidate if candidate > from
          n += 1
        end
      end
    end

    def occurrences(start, until_date, frequency, interval = 1, limit = 366)
      start = start.is_a?(Date) ? start : Date.iso8601(start.to_s)
      until_date = until_date.is_a?(Date) ? until_date : Date.iso8601(until_date.to_s)
      dates = []
      current = start
      while current <= until_date && dates.length < limit
        dates << current
        current = next_occurrence(start, current, frequency, interval)
      end
      dates
    end

    def period_bounds(on, period, month_start_day = 1)
      start = month_start_day.to_i.clamp(1, 28)
      return [Date.new(on.year, 1, 1), Date.new(on.year, 12, 31)] if period.to_s == "year"
      first = Date.new(on.year, on.month, start)
      first <<= 1 if on.day < start
      [first, (first >> 1) - 1]
    end

    def budget_status(spent, limit, alert_percent = 90)
      ratio = if limit.positive?
        spent / limit
      else
        (spent.positive? ? Float::INFINITY : 0)
      end
      level = if ratio > 1
        "over"
      elsif ratio * 100 >= alert_percent
        "warning"
      else
        "ok"
      end
      {spent: spent, limit: limit, remaining: limit - spent, ratio: ratio.to_f, level: level}
    end
  end
end
