module Finance
  class DashboardController < BaseController
    class InvalidAccount < StandardError; end

    def index
      @accounts = current_user.finance_bank_accounts.ordered.to_a
      @filter_values = params.permit(:preset, :start_date, :end_date, :account_id).to_h.symbolize_keys
      @period = DashboardPeriod.new(**@filter_values.slice(:preset, :start_date, :end_date), today: finance_today)
      raise InvalidAccount if params[:account_id] && !params[:account_id].is_a?(String)
      @selected_account = @accounts.find { |account| account.id.to_s == @filter_values[:account_id] }
      raise InvalidAccount if @filter_values[:account_id].present? && !@selected_account

      @filter_values = {preset: @period.preset, start_date: @period.start_date&.iso8601,
                        end_date: @period.end_date&.iso8601, account_id: @selected_account&.id}
      bounds = {start_date: @period.start_date, end_date: @period.end_date, account_id: @selected_account&.id}
      @snapshot = Snapshot.new(user: current_user, **bounds).to_h
      @recent_transactions = @snapshot[:recent_transactions].first(6)
      @spending_mix = SpendingBreakdown.new(user: current_user).mix(**bounds)
      @has_transactions = current_user.finance_transactions.live.exists?
    rescue DashboardPeriod::InvalidPeriod, InvalidAccount => error
      @date_filter_error = error.is_a?(DashboardPeriod::InvalidPeriod)
      @filter_error = @date_filter_error ? I18n.t("billie.backend.date_filter_not_applied", error: error.message) : I18n.t("billie.overview.invalid_account")
      @period ||= DashboardPeriod.new(preset: "all_time")
      @snapshot = nil
      @has_transactions = current_user.finance_transactions.live.exists?
      render :index, status: :unprocessable_entity
    end
  end
end
