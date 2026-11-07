module Finance
  class ForecastController < BaseController
    def show
      @forecast = CashFlowForecast.new(user: current_user, days: params.fetch(:days, 30),
        income_adjustment: params.fetch(:income_adjustment, 0), expense_adjustment: params.fetch(:expense_adjustment, 0),
        engine: params[:engine]).to_h
    rescue CashFlowForecast::InvalidScenario => error
      @forecast_error = error.message
      engine = params[:engine] if %w[prophet chronos linear].include?(params[:engine])
      @forecast = CashFlowForecast.new(user: current_user, engine: engine).to_h
      render :show, status: :unprocessable_entity
    end
  end
end
