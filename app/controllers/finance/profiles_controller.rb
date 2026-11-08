module Finance
  class ProfilesController < BaseController
    def update
      return use_statement_balance if params[:use_statement_balance] == "1"

      attributes = params.require(:finance_profile).permit(:currency, :current_balance, :cash_on_hand, :tax_country, :tax_profile)
      # Typing a balance makes it yours: automatic updates from statements stop until you ask for them back.
      attributes = attributes.merge(balance_source: "manual", balance_as_of: Date.current) if attributes.key?(:current_balance)
      attributes = attributes.merge(cash_on_hand_on: Date.current) if attributes.key?(:cash_on_hand)
      saved = current_user.with_lock do
        @profile.reload
        @profile.update(attributes)
      end
      if saved
        redirect_to return_path, notice: I18n.t("billie.backend.profile_saved")
      else
        redirect_to return_path, alert: @profile.errors.full_messages.to_sentence
      end
    end

    private

    def use_statement_balance
      unless BalanceSync.statement_balance_available?(current_user)
        return redirect_to return_path, alert: I18n.t("billie.backend.automatic_balance_unavailable")
      end
      current_user.with_lock do
        @profile.reload.update!(balance_source: nil, balance_as_of: nil)
        BalanceSync.call(user: current_user)
      end
      redirect_to return_path, notice: I18n.t("billie.backend.automatic_balance_enabled")
    end

    def return_path
      case params[:return_to]
      when "insights" then finance_insights_path
      when "dashboard" then finance_dashboard_path(anchor: "accounts")
      else finance_forecast_path
      end
    end
  end
end
