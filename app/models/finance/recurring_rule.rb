module Finance
  # A template plus a schedule that creates entries (周期记账). Posting is idempotent per date.
  class RecurringRule < ActiveRecord::Base
    self.table_name = "finance_recurring_rules"

    belongs_to :user
    has_many :transactions, class_name: "Finance::Transaction", dependent: :nullify

    validates :name, presence: true, length: {maximum: 60}
    validates :frequency, inclusion: {in: Domain::FREQUENCIES}
    validates :interval, numericality: {only_integer: true, in: 1..365}
    validates :start_on, presence: true
    validate :end_after_start

    before_save { self.next_on ||= start_on }

    # Dates on or before `today` that still need an entry.
    def due_dates(today = Date.current)
      return [] if paused
      last = [today, end_on].compact.min
      # Anchored on start_on so month-end days do not drift (Jan 31 -> Feb 28 -> Mar 31).
      from = next_on || start_on
      Domain.occurrences(start_on, last, frequency, interval, 5000).select { |date| date >= from }.first(120)
    end

    def upcoming(count = 3, from: Date.current, through: nil)
      first = [next_on || start_on, from].max
      dates = []
      current = (first == start_on) ? start_on : Domain.next_occurrence(start_on, first - 1, frequency, interval)
      last = [end_on, through].compact.min
      while dates.length < count && (last.nil? || current <= last)
        dates << current
        current = Domain.next_occurrence(start_on, current, frequency, interval)
      end
      dates
    end

    private

    def end_after_start
      errors.add(:end_on, :invalid) if end_on && start_on && end_on < start_on
    end
  end
end
