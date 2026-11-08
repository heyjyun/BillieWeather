module Finance
  class SettingsController < BaseController
    def show
      @user = current_user
    end

    def update
      @user = current_user
      if @user.update(params.require(:user).permit(:usage_region))
        redirect_to finance_settings_path, status: :see_other, notice: t("billie.region.saved")
      else
        render :show, status: :unprocessable_entity
      end
    end
  end
end
