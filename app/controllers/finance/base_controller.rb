module Finance
  class BaseController < ApplicationController
    layout "billie"
    before_action :authenticate_user!
    before_action :require_usage_region, unless: -> { controller_name == "settings" }
    before_action :load_finance_profile
    before_action :require_enabled_module
    helper_method :finance_today, :manual_mode?, :module_enabled?, :enabled_modules, :current_module_id
    after_action :prevent_financial_page_caching
    after_action :preserve_flash_for_turbo_reload

    private

    # Manual Mode (see Finance::ManualWorkspace). Off until the person turns it on, so the first visit
    # always shows the simple, automation-first interface.
    def manual_mode?
      session[ManualWorkspace::SESSION_KEY] == "manual"
    end

    # Feature Library (Finance::ModuleCatalog). Hidden modules are a view preference, not a permission:
    # the person's own data stays reachable by re-enabling, and every authorization check still runs.
    def module_choices
      @module_choices ||= ModuleCatalog.choices_for(current_user)
    end

    def module_enabled?(id) = ModuleCatalog.enabled?(id, module_choices)

    def enabled_modules = ModuleCatalog.enabled_modules(module_choices)

    def current_module_id = ModuleCatalog.module_for_controller(controller_name)

    # Opening a page of a hidden module shows "this module is off" with a way to turn it on, instead of
    # the page (or a 404). Nothing is changed or deleted, and it is checked before Manual Mode is
    # switched on, so a hidden page does not change the mode either. Writes are refused the same way.
    def require_enabled_module
      id = current_module_id
      return if id.nil? || module_enabled?(id)
      @disabled_module = ModuleCatalog.find(id)
      respond_to do |format|
        format.html { render "finance/feature_library/disabled", status: request.get? ? :ok : :forbidden }
        format.json { render json: {error: "module_disabled", module: id}, status: :forbidden }
        format.any { head :forbidden }
      end
    end

    def ledger
      @ledger ||= Ledger.new(current_user)
    end

    # "All set, Jyun! Your statement has been imported." followed by the import's own details.
    def imported_notice(details)
      "#{helpers.personal_message(:import_done, current_user)} #{details}"
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

    # Counts for the manual workspace's review lists (income to check, possible duplicates, trash).
    def ledger_review_counts
      income = current_user.finance_transactions.live.where(kind: "income").where.not("jsonb_exists(user_locked_fields, 'kind')")
        .includes(:bank_account, statement: :bank_account).limit(2000).count do |entry|
          Domain.suspect_income(kind: entry.kind, amount: entry.amount, account_type: entry.account_type, description: entry.original_description)
        end
      duplicates = current_user.finance_transaction_links.suggested.where(link_type: "duplicate_of").joins(:from_transaction).where(finance_transactions: {deleted_at: nil, superseded_by_id: nil}).count
      {income: income, duplicates: duplicates, trash: current_user.finance_transactions.trashed.count}
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
