module FinanceHelper
  def finance_money(amount, currency = "USD")
    units = {"USD" => "$", "CAD" => "CA$", "EUR" => "€", "GBP" => "£", "AUD" => "A$", "CNY" => "¥"}
    number_to_currency(amount || 0, unit: units.fetch(currency, "#{currency} "), precision: 2)
  end

  def finance_date(value, format = "%b %-d, %Y")
    value.present? ? value.to_date.strftime(format) : "—"
  end

  def finance_balance_available?(profile, summary = @balance_summary)
    profile.balance_source == "manual" ||
      (profile.balance_source.blank? && profile.current_balance.to_d.nonzero?) ||
      summary&.dig(:total).present?
  end

  def finance_balance_display(profile, summary = @balance_summary)
    return "Not available" unless finance_balance_available?(profile, summary)

    balance = if profile.balance_source == "manual" || (profile.balance_source.blank? && profile.current_balance.to_d.nonzero?)
      profile.current_balance
    else
      summary[:total]
    end
    finance_money(balance, profile.currency)
  end

  # How old the balance is. A statement balance is a snapshot, so activity after its date is not included.
  def finance_balance_age_note(profile, summary = @balance_summary, today: Date.current)
    return unless finance_balance_available?(profile, summary)
    manual = profile.balance_source == "manual" || (profile.balance_source.blank? && profile.current_balance.to_d.nonzero?)
    as_of = manual ? profile.balance_as_of : summary&.dig(:as_of_start)
    return unless as_of
    days = (today - as_of.to_date).to_i
    return "Balance is as of today." if days <= 0
    "Balance is as of #{finance_date(as_of)}#{" (#{pluralize(days, "day")} ago); activity after that date is not included" if days > 1}."
  end

  def finance_balance_note(profile, summary = @balance_summary)
    if profile.balance_source == "manual" || (profile.balance_source.blank? && profile.current_balance.to_d.nonzero?)
      return "Entered by you#{" on #{finance_date(profile.balance_as_of)}" if profile.balance_as_of}. This overrides automatic account totals."
    end
    return finance_balance_setup_message(summary) unless summary&.dig(:total).present?

    count = Array(summary[:accounts]).count { |item| item[:status].to_s == "known" }
    note = "Automatically totals the latest balance for #{pluralize(count, "cash account")}."
    if summary[:as_of_start].present?
      dates = finance_date(summary[:as_of_start])
      dates += " – #{finance_date(summary[:as_of_end])}" if summary[:as_of_end].present? && summary[:as_of_end] != summary[:as_of_start]
      note += " Statement dates: #{dates}."
    end
    note += " Partial total: some accounts or balances still need attention." unless summary[:complete]
    note
  end

  def finance_balance_setup_message(summary = @balance_summary)
    unassigned = Array(summary&.dig(:unassigned_statements))
    accounts = Array(summary&.dig(:accounts))
    if unassigned.any?
      dated_balances = unassigned.count { |statement| !statement.closing_balance.nil? && statement.closing_balance_on.present? }
      if dated_balances.positive?
        return "Dated closing balances are saved for #{pluralize(dated_balances, "statement")}, but their accounts are not identified. Choose their accounts in Statement history to include them in the automatic total."
      end
      if unassigned.any? { |statement| !statement.closing_balance.nil? }
        return "Closing balances were saved, but their accounts and balance dates still need confirmation. Review Statement history; a transaction date alone does not confirm the balance date."
      end
      if accounts.empty?
        return "Transactions were imported from your #{pluralize(unassigned.length, "statement")}, but no account details or closing balances are saved. If your files have account details and a balance column, upload them again: the missing details are filled in automatically and nothing is imported twice. You can also enter your balance yourself."
      end
    end
    cash_accounts = accounts.reject { |item| item[:status].to_s == "excluded_credit" }
    if accounts.any? && cash_accounts.empty? && unassigned.empty?
      return "Only credit accounts are identified. Their balances are money owed, so they are excluded from starting cash. A dated checking or savings balance is needed."
    end
    if cash_accounts.any? { |item| item[:status].to_s == "future_date" }
      return "Cash account balance dates are in the future. Review the dates in the account breakdown before using these balances."
    end
    if cash_accounts.any? { |item| item[:status].to_s == "missing_date" }
      return "Cash account balances have no confirmed dates. Review the balance dates in Statement history before using them."
    end
    if cash_accounts.any? { |item| item[:status].to_s == "missing_balance" }
      return "The latest statements for your cash accounts have no usable closing balances saved. Check the original statements for their dated balances; older balances are not silently substituted."
    end
    if cash_accounts.any? { |item| item[:status].to_s == "unknown_kind" }
      return "The account types are not confirmed. Identify checking or savings accounts in Statement history to calculate starting cash."
    end
    "No dated cash account balance is available yet. Import a statement with account details and a closing balance to calculate this automatically."
  end

  def finance_account_balance_status(item)
    case item[:status].to_s
    when "known" then "Included in cash total"
    when "missing_balance" then "Latest statement has no readable closing balance"
    when "missing_date" then "Balance date needs confirmation"
    when "future_date" then "Future-dated balance is not included"
    when "excluded_credit" then "Credit card balance · excluded from cash"
    when "unknown_kind" then "Confirm whether this is a cash account or credit card"
    else "Not included in cash total"
    end
  end

  def finance_period(snapshot)
    return "No statement data yet" unless snapshot[:period_start].present? && snapshot[:period_end].present?
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
      "settings" => "M4 7h16 M4 17h16 M9 4v6 M15 14v6"
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
end
