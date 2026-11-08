module Finance
  class DashboardPeriod
    class InvalidPeriod < StandardError; end

    PRESETS = %w[all_time this_month last_month last_30_days this_year last_year custom].freeze
    attr_reader :preset, :start_date, :end_date

    def initialize(preset: nil, start_date: nil, end_date: nil, today: Date.current)
      @preset = preset.presence || ((start_date.present? || end_date.present?) ? "custom" : "all_time")
      raise InvalidPeriod, I18n.t("billie.backend.invalid_date_range") unless PRESETS.include?(@preset)

      case @preset
      when "custom"
        if start_date.blank? || end_date.blank?
          raise InvalidPeriod, I18n.t("billie.backend.choose_both_dates")
        end
        @start_date = parse_date(start_date)
        @end_date = parse_date(end_date)
      when "this_month"
        @start_date, @end_date = today.beginning_of_month, today.end_of_month
      when "last_month"
        @start_date, @end_date = today.prev_month.beginning_of_month, today.prev_month.end_of_month
      when "last_30_days"
        @start_date, @end_date = today - 29, today
      when "this_year"
        @start_date, @end_date = today.beginning_of_year, today.end_of_year
      when "last_year"
        @start_date, @end_date = today.prev_year.beginning_of_year, today.prev_year.end_of_year
      end
      if @start_date && @end_date && @start_date > @end_date
        raise InvalidPeriod, I18n.t("billie.backend.date_order")
      end
    end

    def filtered?
      preset != "all_time"
    end

    private

    def parse_date(value)
      text = value.to_s
      raise ArgumentError unless /\A\d{4}-\d{2}-\d{2}\z/.match?(text)
      date = Date.iso8601(text)
      raise ArgumentError unless date.year.between?(1900, 2100)
      date
    rescue ArgumentError
      raise InvalidPeriod, I18n.t("billie.backend.date_format")
    end
  end
end
