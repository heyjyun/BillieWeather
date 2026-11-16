module Finance
  # Creates the entries of recurring rules (周期记账) that are due, once per rule and date: the
  # (recurring_rule_id, recurring_on, account) unique index makes posting idempotent even if it runs twice.
  class RecurringPoster
    def self.call(user:, today: Date.current, rules: nil)
      new(user, today).call(rules)
    end

    def initialize(user, today)
      @user = user
      @today = today
      @ledger = Ledger.new(user)
    end

    # Returns {posted:, failed: [[rule_name, codes]]}.
    def call(rules = nil)
      posted = 0
      failed = []
      (rules || RecurringRule.where(user_id: @user.id, paused: false)).each do |rule|
        rule.due_dates(@today).each do |date|
          next if Transaction.where(user_id: @user.id, recurring_rule_id: rule.id, recurring_on: date).exists?
          @ledger.create(rule.template.symbolize_keys.merge(booked_on: date.iso8601), actor: "recurring", origin: "recurring", recurring: [rule, date])
          posted += 1
        rescue Ledger::Invalid => error
          failed << [rule.name, error.codes]
          break
        rescue ActiveRecord::RecordNotUnique
          next
        end
        last = rule.due_dates(@today).last || (rule.next_on && rule.next_on - 1)
        rule.update_columns(next_on: Domain.next_occurrence(rule.start_on, last, rule.frequency, rule.interval), updated_at: Time.current) if last && failed.none? { |name, _| name == rule.name }
      end
      {posted: posted, failed: failed}
    end
  end
end
