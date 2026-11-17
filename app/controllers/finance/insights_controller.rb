module Finance
  class InsightsController < BaseController
    skip_before_action :load_finance_profile, only: :chat
    rate_limit to: 10, within: 1.minute, by: -> { current_user&.id || request.remote_ip }, only: :chat,
      with: -> { render json: {error: I18n.t("billie.insight_chat.errors.rate_limited")}, status: :too_many_requests }

    def show
      load_insights
    end

    def generate
      provider = (params[:provider] == "openai") ? "openai" : "rules"
      if provider == "openai" && current_user.finance_insights.general.where(source: "openai").where("generated_at > ?", 1.minute.ago).exists?
        load_insights
        flash.now[:alert] = I18n.t("billie.backend.analysis_wait")
        return render :show, status: :too_many_requests
      end
      generator = InsightGenerator.new(user: current_user, provider: provider, consent: params[:consent] == "1", kind: "general")
      generator.call
      notice = if provider == "openai"
        I18n.t("billie.backend.analysis_generated")
      else
        I18n.t("billie.backend.basic_analysis_refreshed")
      end
      redirect_to finance_insights_path, notice: notice
    rescue InsightGenerator::Error => error
      load_insights
      flash.now[:alert] = error.message
      render :show, status: :unprocessable_entity
    end

    # "Ask Billie": one answer for the conversation the browser sends. Nothing is stored.
    def chat
      raw = params[:messages]
      messages = raw.is_a?(Array) ? raw.last(InsightChat::MAX_TURNS).filter_map { |message| message.permit(:role, :content).to_h if message.is_a?(ActionController::Parameters) } : []
      answer = InsightChat.new(user: current_user, messages: messages, consent: params[:consent].to_s == "1").call
      render json: {answer: answer}
    rescue InsightChat::Error => error
      render json: {error: error.message}, status: :unprocessable_entity
    end

    private

    def load_insights
      @snapshot = Snapshot.new(user: current_user).to_h
      @insight = current_user.finance_insights.general.latest_first.first
      @insight_stale = insight_stale?(@insight)
      @ai_available = InsightGenerator.ai_available?
    end
  end
end
