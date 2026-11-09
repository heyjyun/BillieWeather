require "caxlsx"

module Finance
  # Builds the .xlsx version of a Finance::Report.
  # Money stays numeric (with a currency number format) so the workbook can be summed and charted.
  # Every text cell is typed as a string with formula escaping on, so a description such as
  # "=HYPERLINK(...)" is stored as plain text and never runs as a formula.
  class ExcelReport
    CURRENCY_UNITS = {"USD" => "$", "CAD" => "CA$", "EUR" => "€", "GBP" => "£", "AUD" => "A$", "CNY" => "¥"}.freeze
    LABEL_KEYS = {
      "Income" => "income", "Housing" => "housing", "Food & dining" => "food", "Transport" => "transport",
      "Utilities" => "utilities", "Shopping" => "shopping", "Health" => "health", "Business" => "business",
      "Transfers" => "transfers", "Uncategorized" => "uncategorized"
    }.freeze

    def initialize(report, sheets: Report::SHEETS)
      @report = report
      @sheets = Report::SHEETS & Array(sheets)
      raise ArgumentError, "choose at least one worksheet" if @sheets.empty?
    end

    def to_stream
      package = Axlsx::Package.new
      package.use_shared_strings = true
      package.workbook.escape_formulas = true if package.workbook.respond_to?(:escape_formulas=)
      @styles = build_styles(package.workbook.styles)
      @sheets.each { |sheet| send(:"add_#{sheet}", package.workbook) }
      package.to_stream
    end

    def to_xlsx
      to_stream.read
    end

    private

    attr_reader :report

    def t(key, **options)
      I18n.t("billie.export.workbook.#{key}", **options)
    end

    def sheet_name(key)
      t("sheets.#{key}").gsub(%r{[\[\]:*?/\\]}, " ").strip.first(31)
    end

    def category_label(name)
      key = LABEL_KEYS[name.to_s]
      key ? I18n.t("billie.helpers.labels.#{key}") : name.to_s
    end

    def yes_no(value)
      value ? t("yes") : t("no")
    end

    def currency_format(currency)
      unit = CURRENCY_UNITS.fetch(currency, "#{currency} ").delete('"')
      %("#{unit}"#,##0.00;[Red]-"#{unit}"#,##0.00)
    end

    def build_styles(styles)
      border = {style: :thin, color: "D8DFDA", edges: [:bottom]}
      money = currency_format(report.currency)
      {
        title: styles.add_style(b: true, sz: 16, fg_color: "2F4F3A"),
        subtitle: styles.add_style(sz: 10, fg_color: "6A765E"),
        header: styles.add_style(b: true, fg_color: "FFFFFF", bg_color: "356B4F", alignment: {vertical: :center, wrap_text: true}),
        label: styles.add_style(b: true, fg_color: "455A42"),
        text: styles.add_style(alignment: {vertical: :top, wrap_text: false}),
        money: styles.add_style(format_code: money),
        money_bold: styles.add_style(format_code: money, b: true, border: border),
        percent: styles.add_style(num_fmt: 10),
        date: styles.add_style(format_code: "yyyy-mm-dd", alignment: {horizontal: :left}),
        month: styles.add_style(format_code: "yyyy-mm", alignment: {horizontal: :left}),
        integer: styles.add_style(num_fmt: 3, alignment: {horizontal: :left}),
        total_label: styles.add_style(b: true, border: border),
        note: styles.add_style(i: true, sz: 9, fg_color: "6A765E")
      }
    end

    # Adds a row of [value, type, style] cells.
    def row(sheet, cells, height: nil)
      values = cells.map { |cell| cell[0] }
      types = cells.map { |cell| cell[1] }
      styles = cells.map { |cell| cell[2] && @styles.fetch(cell[2]) }
      options = {types: types, style: styles, escape_formulas: true}
      options[:height] = height if height
      sheet.add_row(values, **options)
    end

    def text(value, style = :text)
      [value.to_s, :string, style]
    end

    def money(value, style = :money)
      value.nil? ? [t("not_available"), :string, :text] : [value.to_d.round(2).to_f, :float, style]
    end

    def date(value, style = :date)
      value.nil? ? ["", :string, :text] : [value, :date, style]
    end

    def integer(value)
      [value.to_i, :integer, :integer]
    end

    def header(sheet, keys)
      row(sheet, keys.map { |key| text(t("columns.#{key}"), :header) }, height: 22)
    end

    def period_text
      period = report.period
      if period.start_date && period.end_date
        "#{period.start_date.iso8601} – #{period.end_date.iso8601}"
      else
        t("all_time")
      end
    end

    def balance_source_text
      return t("not_available") if report.available_balance.nil?
      t(report.profile.manual_balance? ? "balance_manual" : "balance_statements")
    end

    def add_overview(workbook)
      snapshot = report.snapshot
      overview = report.account_overview
      workbook.add_worksheet(name: sheet_name(:overview)) do |sheet|
        row(sheet, [text(t("title"), :title)], height: 24)
        row(sheet, [text(t("generated_at", time: I18n.l(Time.current, format: :long)), :subtitle)])
        sheet.add_row []
        row(sheet, [text(t("rows.period"), :label), text(period_text)])
        row(sheet, [text(t("rows.data_range"), :label), text([snapshot[:period_start], snapshot[:period_end]].compact.map(&:iso8601).uniq.join(" – ").presence || t("no_transactions"))])
        row(sheet, [text(t("rows.currency"), :label), text(report.currency)])
        sheet.add_row []
        row(sheet, [text(t("rows.total_income"), :label), money(snapshot[:income])])
        row(sheet, [text(t("rows.total_expenses"), :label), money(snapshot[:expenses])])
        row(sheet, [text(t("rows.net_cash_flow"), :label), money(snapshot[:net], :money_bold)])
        row(sheet, [text(t("totals_note"), :note)])
        sheet.add_row []
        row(sheet, [text(t("rows.available_balance"), :label), money(report.available_balance, :money_bold)])
        row(sheet, [text(t("rows.balance_as_of"), :label), date(report.balance_as_of)])
        row(sheet, [text(t("rows.balance_source"), :label), text(balance_source_text)])
        row(sheet, [text(t("rows.cash_on_hand"), :label), money(overview.cash_on_hand)])
        row(sheet, [text(t("rows.owed_on_credit_cards"), :label), money(overview.credit_total)])
        row(sheet, [text(t("balance_note"), :note)])
        sheet.add_row []
        row(sheet, [text(t("rows.transactions"), :label), integer(snapshot[:transaction_count])])
        row(sheet, [text(t("rows.statements"), :label), integer(snapshot[:statement_count])])
        row(sheet, [text(t("rows.uncategorized"), :label), integer(snapshot[:uncategorized_count])])
        row(sheet, [text(t("rows.transfers"), :label), integer(snapshot[:transfer_count])])
        row(sheet, [text(t("rows.excluded"), :label), integer(snapshot[:excluded_count])])
        sheet.add_row []
        row(sheet, [text(t("monthly_heading"), :label)])
        header(sheet, %w[month income expenses net])
        if snapshot[:monthly].empty?
          row(sheet, [text(t("no_transactions"), :note)])
        else
          snapshot[:monthly].each do |month|
            row(sheet, [date(month[:month], :month), money(month[:income]), money(month[:expenses]), money(month[:net])])
          end
        end
        sheet.column_widths 34, 22, 18, 18
      end
    end

    def add_accounts(workbook)
      summary = report.balance_summary
      overview = report.account_overview
      workbook.add_worksheet(name: sheet_name(:accounts)) do |sheet|
        header(sheet, %w[account bank type last4 balance amount_owed as_of status])
        accounts = Array(summary[:accounts])
        accounts.each do |item|
          account = item[:account]
          row(sheet, [text(account.display_name), text(account.bank_name), text(t("account_kinds.#{account.kind}", default: account.kind)),
            text(account.last4), (item[:balance].nil? ? text("") : money(item[:balance])),
            (item[:credit_balance].nil? ? text("") : money(item[:credit_balance])), date(item[:as_of]),
            text(t("account_statuses.#{item[:status]}", default: item[:status].to_s))])
        end
        row(sheet, [text(t("rows.cash_on_hand")), text(""), text(t("account_kinds.cash")), text(""), money(overview.cash_on_hand),
          text(""), date(report.profile.cash_on_hand_on), text("")])
        row(sheet, [text(t("rows.total_cash"), :total_label), text("", :total_label), text("", :total_label), text("", :total_label),
          money(overview.total_cash, :money_bold), money(overview.credit_total || 0, :money_bold), text("", :total_label), text("", :total_label)])
        if accounts.empty?
          row(sheet, [text(t("no_accounts"), :note)])
        end
        if overview.cash_total_partial?
          row(sheet, [text(t("partial_total_note"), :note)])
        end
        if overview.unassigned_count.positive?
          row(sheet, [text(t("unassigned_note", count: overview.unassigned_count), :note)])
        end
        sheet.column_widths 38, 20, 14, 8, 16, 16, 14, 30
        sheet.sheet_view.pane { |pane|
          pane.top_left_cell = "A2"
          pane.state = :frozen
          pane.y_split = 1
        }
      end
    end

    def add_categories(workbook)
      categories = report.categories
      workbook.add_worksheet(name: sheet_name(:categories)) do |sheet|
        header(sheet, %w[category amount share])
        categories.each do |category|
          share = category[:share].nil? ? text("") : [category[:share].round(6).to_f, :float, :percent]
          row(sheet, [text(category_label(category[:name])), money(category[:amount]), share])
        end
        if categories.empty?
          row(sheet, [text(t("no_expenses"), :note)])
        else
          row(sheet, [text(t("rows.total_expenses"), :total_label), money(report.snapshot[:expenses], :money_bold), [1.0, :float, :percent]])
        end
        row(sheet, [text(t("totals_note"), :note)])
        sheet.column_widths 28, 18, 18
      end
    end

    def add_transactions(workbook)
      workbook.add_worksheet(name: sheet_name(:transactions)) do |sheet|
        header(sheet, %w[date account merchant description category amount currency tax_review excluded counted])
        count = 0
        report.each_transaction_row do |item|
          count += 1
          row(sheet, [date(item.booked_on), text(item.account), text(item.merchant), text(item.description), text(category_label(item.category)),
            money(item.amount), text(item.currency), text(yes_no(item.tax_review)), text(yes_no(item.excluded)), text(yes_no(item.counted))])
        end
        if count.zero?
          row(sheet, [text(t("no_transactions"), :note)])
        else
          sheet.auto_filter = "A1:J#{count + 1}"
        end
        sheet.column_widths 12, 34, 22, 48, 18, 14, 10, 11, 10, 16
        sheet.sheet_view.pane { |pane|
          pane.top_left_cell = "A2"
          pane.state = :frozen
          pane.y_split = 1
        }
      end
    end
  end
end
