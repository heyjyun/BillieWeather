module Finance
  class DashboardController < BaseController
    class InvalidScope < StandardError; end

    def index
      @accounts = current_user.finance_bank_accounts.ordered.to_a
      @period = DashboardPeriod.new(**params.permit(:preset, :start_date, :end_date).to_h.symbolize_keys, today: finance_today)
      @account = @accounts.find { |a| a.id.to_s == params[:account_id] }
      raise InvalidScope if params[:account_id].present? && !@account
      @currencies = ([@profile.currency] + @accounts.filter_map(&:currency) + current_user.finance_statements.distinct.pluck(:currency)).uniq
      @currency = params[:currency].presence || @account&.currency || @profile.currency
      raise InvalidScope unless @currencies.include?(@currency)
      raise InvalidScope if @account && (@account.currency.presence || @profile.currency) != @currency

      return unless request.format.json?
      section = params[:section]
      return head :not_found unless OverviewData::SECTIONS.include?(section)
      data = OverviewData.new(user: current_user, profile: @profile, accounts: @accounts, account: @account,
        currency: @currency, period: @period, today: finance_today)
      render body: data.public_send(section).to_json, content_type: "application/json"
    rescue DashboardPeriod::InvalidPeriod, InvalidScope => error
      @filter_error = error.is_a?(InvalidScope) ? I18n.t("billie.overview.invalid_account") : error.message
      respond_to do |format|
        format.html { render :index, status: :unprocessable_entity }
        format.json { render json: {error: @filter_error}, status: :unprocessable_entity }
      end
    end

    private

    # Opening widgets concurrently is read-only. Other finance modules still perform their
    # normal statement balance synchronization and housekeeping.
    def load_finance_profile
      @profile = if request.format.json?
        current_user.finance_profile || Profile.new(user: current_user, currency: "USD")
      else
        Profile.find_or_create_by!(user: current_user)
      end
    end
  end
end
