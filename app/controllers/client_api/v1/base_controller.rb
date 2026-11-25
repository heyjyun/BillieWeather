module ClientApi
  module V1
    # JSON API for the BillieWeather apps. Account information only: the apps never
    # send statements or transactions here. Responses are never cached.
    class BaseController < ActionController::API
      before_action { response.headers["Cache-Control"] = "no-store" }

      rescue_from ActionController::ParameterMissing do |error|
        render json: {error: "bad_request", message: error.message}, status: :bad_request
      end

      private

      def authenticate_client!
        @current_session = ClientApi::SessionToken.session(bearer_token)
        @current_user = @current_session&.user
        render json: {error: "unauthorized"}, status: :unauthorized unless @current_user
      end

      def bearer_token = request.authorization.to_s[/\ABearer (.+)\z/, 1]

      attr_reader :current_user, :current_session

      # Everything the apps may know about an account. No financial data.
      def account_json(user)
        {
          owner_id: user.finance_owner_uid,
          email: user.email,
          nickname: user.nickname,
          locale: user.locale.presence,
          time_zone: user.time_zone.presence,
          usage_region: user.usage_region,
          registered_at: user.created_at&.iso8601,
          badges: user.community_badges
        }
      end
    end
  end
end
