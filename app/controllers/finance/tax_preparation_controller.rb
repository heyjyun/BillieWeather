module Finance
  class TaxPreparationController < BaseController
    def show
      load_tax_preparation
    end

    # Billie's tax preparation insights always use the AI service; there is no rules-based version.
    def generate
      if current_user.finance_insights.tax.where(source: "openai").where("generated_at > ?", 1.minute.ago).exists?
        load_tax_preparation
        flash.now[:alert] = I18n.t("billie.backend.analysis_wait")
        return render :show, status: :too_many_requests
      end
      generator = InsightGenerator.new(user: current_user, provider: "openai", consent: params[:consent] == "1", kind: "tax")
      generator.call
      notice = I18n.t("billie.backend.tax_analysis_generated")
      redirect_to finance_tax_preparation_path, notice: notice
    rescue InsightGenerator::Error => error
      load_tax_preparation
      flash.now[:alert] = error.message
      render :show, status: :unprocessable_entity
    end

    private

    def load_tax_preparation
      @snapshot = Snapshot.new(user: current_user).to_h
      @tax_insight = current_user.finance_insights.tax.latest_first.first
      @tax_insight_stale = insight_stale?(@tax_insight)
      # The general analysis may include a tax checklist; show it until Billie prepares a dedicated one.
      @insight = current_user.finance_insights.general.latest_first.first
      @ai_available = InsightGenerator.ai_available?
    end
  end
end
