require "date"

module Finance
  # Works out which year short "MM/DD" statement dates belong to, so users do not
  # have to type a statement year.
  #
  # The statement's closing date is taken from period/closing-date wording when
  # present (confident). Otherwise the latest plausible full date in the document
  # is used, or today if there is none; both of those are reported as not
  # confident so the caller can ask a person to review the dates.
  class StatementYearResolver
    MONTHS = %w[jan feb mar apr may jun jul aug sep oct nov dec].freeze
    # Wording that usually sits next to the statement period or closing date.
    PERIOD_LABEL = /statement\s+(?:period|date)|billing\s+(?:period|cycle)|closing\s+date|period\s+(?:ending|covered)|for\s+the\s+period|(?:through|thru)\b|\bending\b/i
    ISO_DATE = /\b(\d{4})-(\d{2})-(\d{2})\b/
    US_DATE = %r{\b(\d{1,2})/(\d{1,2})/(\d{4})\b}
    LONG_DATE = /\b(#{MONTHS.join("|")})[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})\b/i
    # Dates far in the future (promotions, maturity dates) must not move the year.
    FUTURE_ALLOWANCE_DAYS = 45
    SLACK_DAYS = 7

    attr_reader :end_date

    def initialize(text, today: Date.current)
      @today = today
      lines = text.to_s.lines
      labelled = labelled_dates(lines)
      if labelled.any?
        @end_date = labelled.max
        @confident = true
      else
        any = plausible(dates_in(text.to_s))
        @end_date = any.max || today
        @confident = false
      end
    end

    def confident?
      @confident
    end

    # Year for a month/day that appears without a year, or nil if the day is not a real date.
    def year_for(month, day)
      end_date.year.downto(end_date.year - 4) do |year|
        next unless Date.valid_date?(year, month, day)
        return year if Date.new(year, month, day) <= end_date + SLACK_DAYS
      end
      nil
    end

    private

    def labelled_dates(lines)
      found = []
      lines.each_with_index do |line, index|
        next unless PERIOD_LABEL.match?(line)
        found.concat(dates_in([line, lines[index + 1]].compact.join(" ")))
      end
      plausible(found)
    end

    def plausible(dates)
      dates.select { |date| date <= @today + FUTURE_ALLOWANCE_DAYS && date.year >= @today.year - 20 }
    end

    def dates_in(text)
      dates = []
      text.scan(ISO_DATE) { |y, m, d| dates << build(y, m, d) }
      text.scan(US_DATE) { |m, d, y| dates << build(y, m, d) }
      text.scan(LONG_DATE) { |mon, d, y| dates << build(y, MONTHS.index(mon.downcase[0, 3]) + 1, d) }
      dates.compact
    end

    def build(year, month, day)
      year, month, day = year.to_i, month.to_i, day.to_i
      Date.new(year, month, day) if Date.valid_date?(year, month, day)
    end
  end
end
