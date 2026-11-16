module Finance
  class BaseController < ApplicationController
    layout "billie"
    before_action :authenticate_user!
    before_action :require_usage_region, unless: -> { controller_name == "settings" }
    before_action :load_finance_profile
    helper_method :finance_today
    after_action :prevent_financial_page_caching
    after_action :preserve_flash_for_turbo_reload

    private

    def ledger
      @ledger ||= Ledger.new(current_user)
    end

    # Human messages for Finance::Ledger / Finance::Domain validation codes (shared with the apps).
    def ledger_errors(codes)
      Array(codes).map { |code| I18n.t("billie.ledger.errors.#{code}", default: I18n.t("billie.ledger.errors.generic")) }.uniq.to_sentence
    end

    def audit!(action, subject, before = {}, after = {}, summary: nil)
      changed = (before.keys | after.keys).reject { |key| before[key] == after[key] }
      AuditEvent.record!(user: current_user, action: action, subject: subject, summary: summary || subject.try(:display_name) || subject.try(:name),
        changes: {"before" => before.slice(*changed), "after" => after.slice(*changed)})
    end

    def audit_values(record, fields)
      record.attributes.slice(*fields).transform_values { |value| value.is_a?(BigDecimal) ? value.to_s("F") : (value.respond_to?(:iso8601) ? value.iso8601 : value) }
    end

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
