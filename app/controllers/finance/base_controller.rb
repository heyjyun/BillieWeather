module Finance
  class BaseController < ApplicationController
    layout "billie"
    before_action :authenticate_user!
    before_action :load_finance_profile
    after_action :prevent_financial_page_caching

    private

    def load_finance_profile
      @profile = Profile.find_or_create_by!(user: current_user)
      current_user.finance_statement_drafts.where("expires_at < ?", Time.current).delete_all unless controller_name == "statement_drafts"
    end

    def prevent_financial_page_caching
      response.headers["Cache-Control"] = "no-store, private"
    end
  end
end
