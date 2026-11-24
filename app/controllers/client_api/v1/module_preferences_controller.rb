module ClientApi
  module V1
    class ModulePreferencesController < BaseController
      before_action :authenticate_client!
      before_action :require_sync
      rate_limit to: 120, within: 1.minute, by: -> { current_user.id },
        with: -> { render json: {error: "rate_limited"}, status: :too_many_requests }

      def show
        render json: Finance::ModulePreferenceSync.new(current_user).snapshot
      end

      def update
        return render json: {error: "invalid"}, status: :unprocessable_entity if request.content_length.to_i > 16.kilobytes
        render json: Finance::ModulePreferenceSync.new(current_user).apply(request.request_parameters)
      rescue Finance::ModulePreferenceSync::Invalid
        render json: {error: "invalid"}, status: :unprocessable_entity
      rescue Finance::ModulePreferenceSync::MutationReused
        render json: {error: "mutation_reused"}, status: :conflict
      end

      private

      def require_sync
        head :not_found unless Finance::ModulePreferenceSync.enabled?
      end
    end
  end
end
