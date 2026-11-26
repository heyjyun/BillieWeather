module Finance
  # Reports (报表) by kind: spending by category (refunds netted), income by category, by account,
  # merchant, project and tag, a monthly trend and net worth, for any period.
  class LedgerReportsController < BaseController

    def show
      @period = DashboardPeriod.new(preset: params[:preset].presence || "this_month", start_date: params[:start_date], end_date: params[:end_date], today: finance_today)
      @dimension = params[:dimension].presence_in(LedgerReport::DIMENSIONS) || "category"
      @report = LedgerReport.new(user: current_user, start_date: @period.start_date, end_date: @period.end_date)
      @rows = @report.by(@dimension)
      @monthly = LedgerReport.new(user: current_user, start_date: (@period.end_date || finance_today) << 11, end_date: @period.end_date || finance_today).monthly
    rescue DashboardPeriod::InvalidPeriod => error
      @period = DashboardPeriod.new(preset: "this_month", today: finance_today)
      flash.now[:alert] = error.message
      retry_render
    end

    private

    def retry_render
      @dimension = "category"
      @report = LedgerReport.new(user: current_user, start_date: @period.start_date, end_date: @period.end_date)
      @rows = @report.by(@dimension)
      @monthly = @report.monthly
      render :show, status: :unprocessable_entity
    end
  end
end
