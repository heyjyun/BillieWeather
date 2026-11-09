class RegistrationsController < Devise::RegistrationsController
  include Registrations::ControllerBase

  layout "billie"

  # Devise's stock DELETE /users destroys the account immediately. BillieWeather requires
  # explicit confirmation and refuses when team data is shared; see AccountDeletion.
  def destroy
    account = params[:user].respond_to?(:permit) ? params[:user].permit(:current_password, :confirm_email) : {}
    deletion = AccountDeletion.new(resource, password: account[:current_password], confirmation: account[:confirm_email])
    if deletion.call
      Devise.sign_out_all_scopes ? sign_out : sign_out(resource_name)
      redirect_to billie_home_path, status: :see_other, notice: t("billie.privacy.account.deleted")
    else
      redirect_to finance_settings_path(anchor: "settings-privacy"), status: :see_other, alert: deletion.error
    end
  end
end
