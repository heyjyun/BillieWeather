module Finance
  class BankAccountsController < BaseController
    # Rename an account. Leaving the name empty goes back to the name read from the statement.
    def update
      account = current_user.finance_bank_accounts.find(params[:id])
      name = params.require(:bank_account).permit(:custom_name)[:custom_name]
      if account.update(custom_name: name)
        notice = account.custom_name.present? ? I18n.t("billie.backend.account_name_saved") : I18n.t("billie.backend.account_name_reset")
        redirect_to finance_dashboard_path(anchor: "accounts"), notice: notice
      else
        redirect_to finance_dashboard_path(anchor: "accounts"), alert: account.errors.full_messages.to_sentence
      end
    end
  end
end
