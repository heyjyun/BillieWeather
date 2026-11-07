module FinanceHelper
  def finance_money(amount, currency = "USD")
    units = {"USD" => "$", "CAD" => "CA$", "EUR" => "€", "GBP" => "£", "AUD" => "A$", "CNY" => "¥"}
    number_to_currency(amount || 0, unit: units.fetch(currency, "#{currency} "), precision: 2)
  end

  def finance_date(value, format = "%b %-d, %Y")
    value.present? ? value.to_date.strftime(format) : "—"
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
    link_to(path, class: "bw-nav-link #{'is-active' if active}", "aria-current": ("page" if active)) do
      safe_join([finance_icon(icon), content_tag(:span, label)])
    end
  end

  def finance_chart_points(points)
    return "" if points.blank?
    values = points.map { |point| point[:balance].to_f }
    low, high = values.minmax
    spread = [high - low, 1.0].max
    points.each_with_index.map do |point, index|
      x = 20 + (index.to_f / [points.length - 1, 1].max * 760)
      y = 210 - ((point[:balance].to_f - low) / spread * 170)
      "#{x.round(2)},#{y.round(2)}"
    end.join(" ")
  end
end
