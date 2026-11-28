module Finance
  class NextStepsController < BaseController
    def show
      state = @profile.assistant_state
      facts = NextStepFacts.for(current_user, @profile, finance_today) unless state["enabled"] == false
      render json: {facts: facts, state: state}
    end

    def update
      if params.key?(:enabled) && !request.format.json?
        @profile.with_lock do
          AssistantFeedback::PREFERENCES.each do |key|
            AssistantFeedback.apply(@profile,key,params[key] == "1") if params.key?(key)
          end
        end
        return redirect_to finance_settings_path
      end
      body = request.request_parameters
      state = AssistantFeedback.apply(@profile, body["key"], body["value"], expected: body.fetch("expected", :any))
      render json: {state: state}
    rescue AssistantFeedback::Invalid
      head :unprocessable_entity
    end
  end
end
