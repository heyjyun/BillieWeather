require "test_helper"

class Finance::DashboardPeriodTest < ActiveSupport::TestCase
  test "custom periods accept inclusive ISO dates including a single day" do
    period = Finance::DashboardPeriod.new(start_date: "2024-10-01", end_date: "2025-10-31")
    assert_equal "custom", period.preset
    assert_equal Date.new(2024, 10, 1), period.start_date
    assert_equal Date.new(2025, 10, 31), period.end_date
    assert period.filtered?
    single_day = Finance::DashboardPeriod.new(preset: "custom", start_date: "2026-11-06", end_date: "2026-11-06")
    assert_equal single_day.start_date, single_day.end_date
  end

  test "calendar presets handle leap months year transitions and inclusive last 30 days" do
    cases = [
      ["last_month", Date.new(2024, 3, 15), Date.new(2024, 2, 1), Date.new(2024, 2, 29)],
      ["last_month", Date.new(2026, 1, 1), Date.new(2025, 12, 1), Date.new(2025, 12, 31)],
      ["this_month", Date.new(2026, 11, 6), Date.new(2026, 11, 1), Date.new(2026, 11, 30)],
      ["last_30_days", Date.new(2026, 1, 10), Date.new(2025, 12, 12), Date.new(2026, 1, 10)],
      ["this_year", Date.new(2026, 11, 6), Date.new(2026, 1, 1), Date.new(2026, 12, 31)],
      ["last_year", Date.new(2026, 11, 6), Date.new(2025, 1, 1), Date.new(2025, 12, 31)]
    ]
    cases.each do |preset, today, expected_start, expected_end|
      period = Finance::DashboardPeriod.new(preset: preset, today: today)
      assert_equal expected_start, period.start_date
      assert_equal expected_end, period.end_date
    end
  end

  test "invalid incomplete reversed or ambiguous date ranges are rejected" do
    [
      {preset: "unknown"}, {preset: "custom"}, {start_date: "2026-11-01"},
      {start_date: "2026-02-30", end_date: "2026-03-01"},
      {start_date: "11/01/2026", end_date: "2026-11-30"},
      {start_date: "2026-11-30", end_date: "2026-11-01"},
      {start_date: "1899-01-01", end_date: "2026-11-30"},
      {start_date: "2026-01-01", end_date: "2101-01-01"}
    ].each do |attributes|
      assert_raises(Finance::DashboardPeriod::InvalidPeriod) { Finance::DashboardPeriod.new(**attributes) }
    end
  end

  test "default all time remains unbounded" do
    period = Finance::DashboardPeriod.new
    assert_equal "all_time", period.preset
    refute period.filtered?
    assert_nil period.start_date
    assert_nil period.end_date
  end
end
