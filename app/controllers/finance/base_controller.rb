module Finance
  class BaseController < ApplicationController
    layout "billie"
    before_action :authenticate_user!
    before_action :require_usage_region, unless: -> { controller_name == "settings" }
    before_action :load_finance_profile
    after_action :prevent_financial_page_caching
    after_action :preserve_flash_for_turbo_reload

    private

    # Today's date where the person lives, so "this month" means the same thing on every page.
    def finance_today
      Time.current.in_time_zone(current_user.time_zone.presence || "America/Chicago").to_date
    end

    def load_finance_profile
      @profile = Profile.find_or_create_by!(user: current_user)
      load_account_balances
      current_user.finance_statement_drafts.where("expires_at < ?", Time.current).delete_all unless controller_name == "statement_drafts"
    end

    def load_account_balances
      @balance_summary = BalanceSync.call(user: current_user)
      @profile.reload
      @bank_accounts = current_user.finance_bank_accounts.order(:bank_name, :name, :last4).to_a
    end

    # When the user's records or profile last changed; insights generated before this are stale.
    def finance_data_changed_at
      [current_user.finance_transactions.maximum(:updated_at), current_user.finance_statements.maximum(:updated_at), @profile.updated_at].compact.max
    end

    def insight_stale?(insight)
      changed_at = finance_data_changed_at
      insight.present? && changed_at.present? && insight.generated_at < changed_at
    end

    def prevent_financial_page_caching
      response.headers["Cache-Control"] = "no-store, private"
    end

    def preserve_flash_for_turbo_reload
      # Leaving the account layout's tracked assets triggers a second, full HTML
      # request. Keep messages until that request displays them in the finance UI.
      flash.keep if request.format.turbo_stream?
    end
  end
end
