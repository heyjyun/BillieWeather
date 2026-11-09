module Finance
  class SettingsController < BaseController
    before_action :load_user

    def show
    end

    def update
      attributes = params.require(:user).permit(:usage_region)
      attributes[:usage_region] = nil unless attributes.key?(:usage_region)
      if @user.update(attributes)
        redirect_to finance_settings_path, status: :see_other, notice: t("billie.region.saved")
      else
        @failed_section = :region
        render :show, status: :unprocessable_entity
      end
    end

    def nickname
      if @user.update(params.require(:user).permit(:nickname))
        redirect_to finance_settings_path, status: :see_other, notice: t("billie.account.nickname_saved")
      else
        @failed_section = :nickname
        render :show, status: :unprocessable_entity
      end
    end

    # A Founding Patron's explicit opt-in to list their nickname on the Features & Membership page.
    def supporter_recognition
      public_listing = params.dig(:user, :supporter_recognition_public) == "1"
      return head :forbidden if public_listing && !@user.founding_patron?
      @user.update!(supporter_recognition_public: public_listing)
      redirect_to finance_settings_path(anchor: "settings-community"), status: :see_other, notice: t("billie.community.settings.recognition_saved")
    end

    # Changing the password always needs the current one, so an unattended
    # signed-in browser cannot be used to take over the account.
    def password
      attributes = params.require(:user).permit(:current_password, :password, :password_confirmation)
      if attributes[:password].blank?
        @user.errors.add(:password, :blank)
      elsif @user.update_with_password(attributes)
        bypass_sign_in(@user)
        return redirect_to finance_settings_path, status: :see_other, notice: t("billie.account.password_changed")
      end
      @user.clean_up_passwords
      @failed_section = :password
      render :show, status: :unprocessable_entity
    end

    # Google accounts get a random password at sign-up; this lets them choose one by email.
    def password_reset
      @user.send_reset_password_instructions
      redirect_to finance_settings_path, status: :see_other, notice: t("billie.account.password_reset_sent", email: @user.email)
    rescue => error
      Rails.logger.warn("Password reset email could not be sent: #{error.class}")
      redirect_to finance_settings_path, status: :see_other, alert: t("billie.account.password_reset_failed")
    end

    private

    def load_user
      @user = current_user
      @account_deletion = AccountDeletion.new(@user)
      @privacy_counts = {statements: @user.finance_statements.count, transactions: @user.finance_transactions.count,
                         accounts: @user.finance_bank_accounts.count}
    end
  end
end
