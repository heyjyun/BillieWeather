module Finance
  class DashboardController < BaseController
    def index
      @filter_values = {preset: params[:preset], start_date: params[:start_date], end_date: params[:end_date]}
      today = Time.current.in_time_zone(current_user.time_zone.presence || "America/Chicago").to_date
      @period = DashboardPeriod.new(**@filter_values, today: today)
      @filter_values = {preset: @period.preset, start_date: @period.start_date&.iso8601, end_date: @period.end_date&.iso8601}
      @snapshot = Snapshot.new(user: current_user, start_date: @period.start_date, end_date: @period.end_date).to_h
      @recent_transactions = @snapshot[:recent_transactions].first(6)
      @has_transactions = current_user.finance_transactions.exists?
    rescue DashboardPeriod::InvalidPeriod => error
      @date_filter_error = I18n.t("billie.backend.date_filter_not_applied", error: error.message)
      @period = DashboardPeriod.new(preset: "all_time")
      @snapshot = nil
      @recent_transactions = []
      @has_transactions = current_user.finance_transactions.exists?
      render :index, status: :unprocessable_entity
    end
  end
end
