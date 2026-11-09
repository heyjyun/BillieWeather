module ClientApi
  module V1
    # The signed-in account's profile and preferences (language, nickname, time zone).
    class AccountsController < BaseController
      before_action :authenticate_client!

      def show
        render json: {account: account_json(current_user)}
      end

      def update
        attributes = params.require(:account).permit(:locale, :nickname, :time_zone)
        if attributes.key?(:locale) && attributes[:locale].present? && !I18n.available_locales.include?(attributes[:locale].to_s.to_sym)
          return render json: {error: "invalid", message: "Unsupported language."}, status: :unprocessable_content
        end
        if attributes.key?(:time_zone) && attributes[:time_zone].present? && !ActiveSupport::TimeZone[attributes[:time_zone].to_s]
          return render json: {error: "invalid", message: "Unknown time zone."}, status: :unprocessable_content
        end
        if current_user.update(attributes)
          render json: {account: account_json(current_user)}
        else
          render json: {error: "invalid", message: current_user.errors.full_messages.to_sentence}, status: :unprocessable_content
        end
      end
    end
  end
end
