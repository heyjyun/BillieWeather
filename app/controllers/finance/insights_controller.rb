module Finance
  class InsightsController < BaseController
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
      notice = if generator.fallback_used?
        I18n.t("billie.backend.analysis_fallback")
      elsif provider == "openai"
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

    private

    def load_insights
      @snapshot = Snapshot.new(user: current_user).to_h
      @insight = current_user.finance_insights.general.latest_first.first
      @insight_stale = insight_stale?(@insight)
      @ai_available = InsightGenerator.ai_available?
    end
  end
end
