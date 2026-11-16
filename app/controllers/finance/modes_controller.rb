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

    # Turning Manual Mode on opens the manual workspace. Turning it off stays on the same page when
    # that page exists in Default Mode, and otherwise returns to the dashboard.
    def destination_for(mode)
      return finance_manual_path if mode == "manual"
      path = params[:return_to].to_s
      safe = path.start_with?("/app") && !path.start_with?("//") && !path.include?("\\")
      (safe && !ManualWorkspace.manual_path?(path)) ? path : finance_dashboard_path
    end
  end
end
