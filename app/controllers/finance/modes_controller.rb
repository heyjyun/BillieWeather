module Finance
  # Switches between Default Mode (simple, automation-first) and Manual Mode (the full manual
  # bookkeeping workspace). Only the session's view preference changes; no record is touched.
  class ModesController < BaseController
    skip_before_action :load_finance_profile

    def update
      mode = params[:mode].presence_in(ManualWorkspace::MODES) || "default"
      session[ManualWorkspace::SESSION_KEY] = mode
      redirect_to destination_for(mode)
    end

    private

    def destination_for(mode)
      path = params[:return_to].to_s
      safe = path.match?(%r{\A/app(?:/|\?|\z)}) && !path.include?("\\")
      return mode == "manual" ? finance_manual_path : finance_dashboard_path unless safe
      return finance_manual_path if mode == "manual" && !path.match?(%r{\A/app/settings(?:/|\?|\z)})
      return finance_dashboard_path if mode == "default" && ManualWorkspace.manual_path?(path)

      path
    end
  end
end
