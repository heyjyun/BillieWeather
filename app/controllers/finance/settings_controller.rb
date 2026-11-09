module Finance
  class SettingsController < BaseController
    def show
      @user = current_user
    end

    def update
      @user = current_user
      attributes = params.require(:user).permit(:usage_region)
      attributes[:usage_region] = nil unless attributes.key?(:usage_region)
      if @user.update(attributes)
        redirect_to finance_settings_path, status: :see_other, notice: t("billie.region.saved")
      else
        render :show, status: :unprocessable_entity
      end
    end
  end
end
