module Finance
  class ForecastController < BaseController
    def show
      @forecast = CashFlowForecast.new(user: current_user, days: params.fetch(:days, 30),
        income_adjustment: params.fetch(:income_adjustment, 0), expense_adjustment: params.fetch(:expense_adjustment, 0)).to_h
    rescue CashFlowForecast::InvalidScenario => error
      @forecast_error = error.message
      @forecast = CashFlowForecast.new(user: current_user).to_h
      render :show, status: :unprocessable_entity
    end
  end
end
