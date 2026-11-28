module ClientApi
  module V1
    # Device-specific evidence and local record identifiers never enter this endpoint.
    class AssistantPreferencesController < BaseController
      before_action :authenticate_client!
      def show
        render json: portable(profile.assistant_state)
      end

      def update
        return head :unprocessable_entity unless request.content_length.to_i <= 2.kilobytes
        body = request.request_parameters
        return head :unprocessable_entity unless body.key?("expected")
        state = Finance::AssistantFeedback.apply(profile, body["key"], body["value"], portable_only: true, expected: body["expected"])
        render json: portable(state)
      rescue Finance::AssistantFeedback::Invalid
        head :unprocessable_entity
      end

      private

      def profile = Finance::Profile.find_or_create_by!(user: current_user)
      def portable(state) = Finance::AssistantFeedback.portable(state)
    end
  end
end
