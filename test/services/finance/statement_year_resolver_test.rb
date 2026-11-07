require "test_helper"

class Finance::StatementYearResolverTest < ActiveSupport::TestCase
  TODAY = Date.new(2026, 11, 6)

  def resolver(text)
    Finance::StatementYearResolver.new(text, today: TODAY)
  end

  test "uses the statement period wording and is confident" do
    r = resolver("Statement Period: Oct 1, 2025 through Oct 31, 2025\nOther text")
    assert r.confident?
    assert_equal Date.new(2025, 10, 31), r.end_date
    assert_equal 2025, r.year_for(10, 5)
  end

  test "reads the date from the line after the label" do
    r = resolver("Statement Date\n10/31/2025\n")
    assert r.confident?
    assert_equal Date.new(2025, 10, 31), r.end_date
  end

  test "December rows of a statement ending in January belong to the earlier year" do
    r = resolver("Billing period 12/15/2025 to 01/14/2026")
    assert_equal 2025, r.year_for(12, 20)
    assert_equal 2026, r.year_for(1, 5)
  end

  test "dates far in the future never decide the year" do
    r = resolver("Statement period 10/01/2025 - 10/31/2025\nPromotion expires 12/31/2031")
    assert_equal Date.new(2025, 10, 31), r.end_date
    r = resolver("Closing date 03/31/2031")
    refute r.confident?
    assert_equal TODAY, r.end_date
  end

  test "falls back to the latest plausible date, then to today, and says it is not confident" do
    r = resolver("Account activity 2025-10-31")
    refute r.confident?
    assert_equal Date.new(2025, 10, 31), r.end_date
    r = resolver("No dates here")
    refute r.confident?
    assert_equal TODAY, r.end_date
    assert_equal 2026, r.year_for(11, 1)
    assert_equal 2025, r.year_for(12, 28)
  end

  test "impossible days return nil and leap days find a leap year" do
    r = resolver("Statement period 01/01/2026 - 03/31/2026")
    assert_nil r.year_for(2, 30)
    assert_equal 2024, r.year_for(2, 29)
  end
end
