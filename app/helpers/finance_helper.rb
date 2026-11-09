module FinanceHelper
  def finance_money(amount, currency = "USD")
    units = {"USD" => "$", "CAD" => "CA$", "EUR" => "€", "GBP" => "£", "AUD" => "A$", "CNY" => "¥"}
    number_to_currency(amount || 0, unit: units.fetch(currency, "#{currency} "), precision: 2)
  end

  def finance_date(value, format = nil)
    return "—" if value.blank?
    format_key = {"%b %Y" => "month_format", "%b %-d" => "month_day_format", "%b %-d, %Y" => "date_format"}[format]
    format = t("billie.helpers.#{format_key}") if format_key
    l(value.to_date, format: format || t("billie.helpers.date_format"))
  end

  def finance_label(value)
    labels = {
      "Income" => "income", "Housing" => "housing", "Food & dining" => "food", "Transport" => "transport",
      "Utilities" => "utilities", "Shopping" => "shopping", "Health" => "health", "Business" => "business",
      "Transfers" => "transfers", "Uncategorized" => "uncategorized", "Checking" => "checking",
      "Savings" => "savings", "Credit account" => "credit_account", "Cash account" => "cash_account", "Account" => "account"
    }
    key = labels[value.to_s]
    key ? t("billie.helpers.labels.#{key}") : value
  end

  def finance_count(count, noun, plural = nil)
    t("billie.helpers.counts.#{noun.to_s.tr(' ', '_')}", count: count, default: pluralize(count, noun, plural))
  end

  def finance_balance_available?(profile, summary = @balance_summary)
    !profile.displayed_balance(summary).nil?
  end

  def finance_balance_display(profile, summary = @balance_summary)
    return t("billie.helpers.unavailable") unless finance_balance_available?(profile, summary)

    finance_money(profile.displayed_balance(summary), profile.currency)
  end

  # How old the balance is. A statement balance is a snapshot, so activity after its date is not included.
  def finance_balance_age_note(profile, summary = @balance_summary, today: Date.current)
    return unless finance_balance_available?(profile, summary)
    as_of = profile.manual_balance? ? profile.balance_as_of : summary&.dig(:as_of_start)
    return unless as_of
    days = (today - as_of.to_date).to_i
    return t("billie.helpers.balance_today") if days <= 0
    t("billie.helpers.#{days > 1 ? 'balance_aged' : 'balance_dated'}", date: finance_date(as_of), days: finance_count(days, "day"))
  end

  def finance_balance_note(profile, summary = @balance_summary)
    if profile.balance_source == "manual" || (profile.balance_source.blank? && profile.current_balance.to_d.nonzero?)
      return t("billie.helpers.#{profile.balance_as_of ? 'manual_dated' : 'manual'}", date: finance_date(profile.balance_as_of))
    end
    return finance_balance_setup_message(summary) unless summary&.dig(:total).present?

    count = Array(summary[:accounts]).count { |item| item[:status].to_s == "known" }
    note = t("billie.helpers.automatic_total", accounts: finance_count(count, "cash account"))
    if summary[:as_of_start].present?
      dates = finance_date(summary[:as_of_start])
      dates += " – #{finance_date(summary[:as_of_end])}" if summary[:as_of_end].present? && summary[:as_of_end] != summary[:as_of_start]
      note += t("billie.helpers.statement_dates", dates: dates)
    end
    note += t("billie.helpers.partial_total") unless summary[:complete]
    note
  end

  def finance_balance_setup_message(summary = @balance_summary)
    unassigned = Array(summary&.dig(:unassigned_statements))
    accounts = Array(summary&.dig(:accounts))
    if unassigned.any?
      dated_balances = unassigned.count { |statement| !statement.closing_balance.nil? && statement.closing_balance_on.present? }
      if dated_balances.positive?
        return t("billie.helpers.setup.unassigned", statements: finance_count(dated_balances, "statement"))
      end
      if unassigned.any? { |statement| !statement.closing_balance.nil? }
        return t("billie.helpers.setup.unconfirmed")
      end
      if accounts.empty?
        return t("billie.helpers.setup.no_details", statements: finance_count(unassigned.length, "statement"))
      end
    end
    cash_accounts = accounts.reject { |item| item[:status].to_s == "excluded_credit" }
    if accounts.any? && cash_accounts.empty? && unassigned.empty?
      return t("billie.helpers.setup.only_credit")
    end
    if cash_accounts.any? { |item| item[:status].to_s == "future_date" }
      return t("billie.helpers.setup.future_date")
    end
    if cash_accounts.any? { |item| item[:status].to_s == "missing_date" }
      return t("billie.helpers.setup.missing_date")
    end
    if cash_accounts.any? { |item| item[:status].to_s == "missing_balance" }
      return t("billie.helpers.setup.missing_balance")
    end
    if cash_accounts.any? { |item| item[:status].to_s == "unknown_kind" }
      return t("billie.helpers.setup.unknown_kind")
    end
    t("billie.helpers.setup.no_balance")
  end

  def finance_account_balance_status(item)
    status = item[:status].to_s
    key = %w[known missing_balance missing_date future_date excluded_credit unknown_kind].include?(status) ? status : "excluded"
    t("billie.helpers.balance_status.#{key}")
  end

  def finance_period(snapshot)
    return t("billie.helpers.no_statement_data") unless snapshot[:period_start].present? && snapshot[:period_end].present?
    "#{finance_date(snapshot[:period_start])} – #{finance_date(snapshot[:period_end])}"
  end

  def finance_icon(name, size: 20)
    paths = {
      "dashboard" => "M3 3h7v7H3z M14 3h7v7h-7z M3 14h7v7H3z M14 14h7v7h-7z",
      "upload" => "M12 16V3 M7 8l5-5 5 5 M3 15v5a1 1 0 001 1h16a1 1 0 001-1v-5",
      "transactions" => "M3 7h16 M15 3l4 4-4 4 M21 17H5 M9 13l-4 4 4 4",
      "forecast" => "M3 3v18h18 M7 15l4-5 4 2 5-7",
      "insights" => "M12 3l2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5z",
      "arrow" => "M5 12h14 M13 6l6 6-6 6",
      "up" => "M7 17L17 7 M7 7h10v10",
      "down" => "M7 7l10 10 M7 17h10V7",
      "wallet" => "M4 5h15v4 M4 5a2 2 0 000 4h17v11H4a2 2 0 01-2-2V7a2 2 0 012-2z M16 13h5v4h-5z",
      "file" => "M14 2H5v20h14V7z M14 2v6h5 M8 12h8 M8 16h8",
      "check" => "M5 12l4 4L19 6",
      "logout" => "M9 4H3v16h6 M13 8l4 4-4 4 M7 12h14",
      "search" => "M21 21l-5-5 M10 3a7 7 0 100 14 7 7 0 000-14",
      "sun" => "M12 1v2 M12 21v2 M1 12h2 M21 12h2 M4.2 4.2l1.4 1.4 M18.4 18.4l1.4 1.4 M4.2 19.8l1.4-1.4 M18.4 5.6l1.4-1.4 M12 7a5 5 0 100 10 5 5 0 000-10",
      "settings" => "M4 7h16 M4 17h16 M9 4v6 M15 14v6",
      "heart" => "M12 20s-7-4.4-7-10a4 4 0 017-2.6A4 4 0 0119 10c0 5.6-7 10-7 10z",
      "crown" => "M3 19h18 M4 16L3 7l5 4 4-6 4 6 5-4-1 9z",
      "badge" => "M12 3a9 9 0 100 18 9 9 0 000-18 M8 12l3 3 5-6",
      "lamp" => "M3 13h12a4 4 0 004-4h2 M5 13c0 3 3 5 7 5s7-2 7-5 M12 9V6 M10 6h4 M8 21h8 M12 18v3",
      "tag" => "M3 3h8l10 10-8 8L3 11z M7.5 7.5h.01",
      "copy" => "M9 9h11v11H9z M5 15H4V4h11v1",
      "close" => "M6 6l12 12 M18 6L6 18",
      "users" => "M9 11a4 4 0 100-8 4 4 0 000 8 M3 21v-1a6 6 0 0112 0v1 M16 3.1a4 4 0 010 7.8 M21 21v-1a6 6 0 00-4-5.6",
      "lock" => "M5 11h14v10H5z M8 11V7a4 4 0 018 0v4",
      "download" => "M12 3v13 M7 11l5 5 5-5 M3 15v5a1 1 0 001 1h16a1 1 0 001-1v-5",
      "laptop" => "M4 5h16v10H4z M2 19h20 M9 19l1-2h4l1 2",
      "monitor" => "M3 4h18v12H3z M8 20h8 M12 16v4",
      "phone" => "M7 2h10a1 1 0 011 1v18a1 1 0 01-1 1H7a1 1 0 01-1-1V3a1 1 0 011-1z M11 18h2",
      "expand" => "M15 3h6v6 M9 21H3v-6 M21 3l-7 7 M3 21l7-7",
      "qr" => "M3 3h7v7H3z M14 3h7v7h-7z M3 14h7v7H3z M14 14h3v3h-3z M20 14v.01 M14 20h.01 M17 17h4v4h-4"
    }
    content_tag(:svg, viewBox: "0 0 24 24", width: size, height: size, fill: "none", stroke: "currentColor", "stroke-width": 1.7, "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": true) do
      tag.path(d: paths.fetch(name.to_s, paths["file"]))
    end
  end

  def finance_nav(label, path, icon, active:)
    link_to(path, class: "bw-nav-link #{"is-active" if active}", "aria-current": ("page" if active)) do
      safe_join([finance_icon(icon), content_tag(:span, label)])
    end
  end

  # Points for one series. The y-scale spans every series in the chart (including the
  # forecast band when present) so the line and band stay aligned.
  def finance_chart_points(points, key: :balance)
    return "" if points.blank?
    low, high = finance_chart_range(points)
    spread = [high - low, 1.0].max
    points.each_with_index.map do |point, index|
      "#{finance_chart_x(index, points.length)},#{finance_chart_y(point[key], low, spread)}"
    end.join(" ")
  end

  # Closed polygon between the lower and upper forecast bounds, or "" without a band.
  def finance_chart_band(points)
    return "" unless points.present? && points.all? { |point| point[:lower] && point[:upper] }
    upper = finance_chart_points(points, key: :upper)
    lower = finance_chart_points(points, key: :lower).split(" ").reverse.join(" ")
    "#{upper} #{lower}"
  end

  def finance_chart_range(points)
    values = points.flat_map { |point| [point[:balance], point[:lower], point[:upper]].compact.map(&:to_f) }
    values.minmax
  end

  def finance_chart_x(index, count)
    (20 + (index.to_f / [count - 1, 1].max * 760)).round(2)
  end

  def finance_chart_y(value, low, spread)
    (210 - ((value.to_f - low) / spread * 170)).round(2)
  end

  # "2.5 MB": sizes on Settings › Your database, the same units the apps show.
  def database_size(bytes)
    value = bytes.to_f
    units = %w[B KB MB GB]
    unit = 0
    while value >= 1024 && unit < units.length - 1
      value /= 1024
      unit += 1
    end
    number = unit.zero? ? value.round.to_s : format("%.1f", value).delete_suffix(".0")
    "#{number} #{units[unit]}"
  end

  def database_range(first, last)
    return "—" unless first && last
    (first == last) ? finance_date(first, "%b %-d, %Y") : "#{finance_date(first, "%b %-d, %Y")} – #{finance_date(last, "%b %-d, %Y")}"
  end

  # A time in the person's own time zone with its abbreviation ("November 9, 2026, 2:30 PM PST"), so a
  # reported time is never ambiguous. Falls back to UTC when no zone is saved.
  def local_report_time(time, user)
    return "—" if time.blank?
    zone = ActiveSupport::TimeZone[user.time_zone.to_s] || ActiveSupport::TimeZone["UTC"]
    time.in_time_zone(zone).strftime("%B %-d, %Y, %-l:%M %p %Z")
  end

  # "12%" of the combined bar; "<1%" for something tiny but not empty.
  def database_share(bytes, total)
    return "0%" if total.to_i <= 0 || bytes.to_i <= 0
    share = bytes.to_f / total * 100
    (share < 1) ? "<1%" : "#{share.round}%"
  end
end
