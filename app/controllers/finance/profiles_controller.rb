module Finance
  class ProfilesController < BaseController
    def update
      attributes = params.require(:finance_profile).permit(:currency, :current_balance, :tax_country, :tax_profile)
      saved = current_user.with_lock do
        @profile.reload
        @profile.update(attributes)
      end
      if saved
        redirect_to return_path, notice: "Financial profile saved."
      else
        redirect_to return_path, alert: @profile.errors.full_messages.to_sentence
      end
    end

    private

    def return_path
      params[:return_to] == "insights" ? finance_insights_path : finance_forecast_path
    end
  end
end
