module Finance
  class InsightsController < BaseController
    def show
      load_insights
    end

    def generate
      kind = (params[:kind] == "tax") ? "tax" : "general"
      # Billie's tax preparation insights always use the AI service; there is no rules-based version.
      provider = (kind == "tax" || params[:provider] == "openai") ? "openai" : "rules"
      if provider == "openai" && current_user.finance_insights.where(source: "openai", kind: kind).where("generated_at > ?", 1.minute.ago).exists?
        load_insights
        flash.now[:alert] = I18n.t("billie.backend.analysis_wait")
        return render :show, status: :too_many_requests
      end
      generator = InsightGenerator.new(user: current_user, provider: provider, consent: params[:consent] == "1", kind: kind)
      generator.call
      notice = if generator.fallback_used?
        I18n.t("billie.backend.analysis_fallback")
      else
        generated_notice(kind, provider)
      end
      redirect_to finance_insights_path, notice: notice
    rescue InsightGenerator::Error => error
      load_insights
      flash.now[:alert] = error.message
      render :show, status: :unprocessable_entity
    end

    private

    def generated_notice(kind, provider)
      return I18n.t("billie.backend.tax_analysis_generated") if kind == "tax"
      (provider == "openai") ? I18n.t("billie.backend.analysis_generated") : I18n.t("billie.backend.basic_analysis_refreshed")
    end

    def load_insights
      @snapshot = Snapshot.new(user: current_user).to_h
      @insight = current_user.finance_insights.general.latest_first.first
      @tax_insight = current_user.finance_insights.tax.latest_first.first
      last_data_change = [current_user.finance_transactions.maximum(:updated_at), current_user.finance_statements.maximum(:updated_at), @profile.updated_at].compact.max
      @insight_stale = @insight && last_data_change && @insight.generated_at < last_data_change
      @tax_insight_stale = @tax_insight && last_data_change && @tax_insight.generated_at < last_data_change
      @ai_available = InsightGenerator.ai_available?
    end
  end
end
