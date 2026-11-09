module Finance
  # "Export report": choose a format (and, for Excel, worksheets), then download.
  # Reports are built on request and streamed straight to the browser; nothing is stored on the server.
  class ReportsController < BaseController
    FORMATS = %w[xlsx csv].freeze
    XLSX_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet".freeze

    def show
      @sheets = Report::SHEETS
      @period = build_period
    rescue DashboardPeriod::InvalidPeriod => error
      @period = DashboardPeriod.new(preset: "all_time")
      @period_error = error.message
      render :show, status: :unprocessable_entity
    end

    def download
      period = build_period
      report = Report.new(user: current_user, profile: @profile, period: period, balance_summary: @balance_summary)
      case export_format
      when "xlsx"
        sheets = selected_sheets
        return redirect_back_to_options(t("billie.export.choose_a_sheet")) if sheets.empty?
        send_data ExcelReport.new(report, sheets: sheets).to_xlsx, type: XLSX_TYPE, disposition: "attachment", filename: report.filename("xlsx")
      when "csv"
        send_data TransactionCsv.generate(report.each_transaction_row), type: "text/csv; charset=utf-8", disposition: "attachment", filename: report.filename("csv")
      else
        redirect_back_to_options(t("billie.export.choose_a_format"))
      end
    rescue DashboardPeriod::InvalidPeriod => error
      redirect_back_to_options(error.message)
    end

    private

    def period_params
      {preset: params[:preset], start_date: params[:start_date], end_date: params[:end_date]}
        .transform_values { |value| value.is_a?(String) ? value : nil }
    end

    def build_period
      DashboardPeriod.new(**period_params, today: finance_today)
    end

    def export_format
      value = params[:export_format]
      value.blank? ? "xlsx" : value.to_s
    end

    # The options form always sends `sheets[]` (with an empty placeholder), so an empty
    # selection means "none chosen". A bare download link with no `sheets` gets every sheet.
    def selected_sheets
      return Report::SHEETS unless params.key?(:sheets)
      requested = params[:sheets]
      requested = requested.is_a?(Array) ? requested.grep(String) : []
      Report::SHEETS & requested
    end

    def redirect_back_to_options(message)
      redirect_to finance_report_path(period_params.compact), status: :see_other, alert: message
    end
  end
end
