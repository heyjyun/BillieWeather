module Finance
  # Manual Mode (手动记账): progressive disclosure for the manual bookkeeping tools. The mode is only a
  # view preference kept in the session; both modes read and write the same tables through the same
  # Finance::Ledger, so switching never copies, changes or deletes a record.
  #
  # Pages that exist only in the manual workspace include this concern: opening one (a bookmark, a
  # redirect after saving, a link from the command bar) is an explicit choice, so it turns Manual Mode on.
  module ManualWorkspace
    extend ActiveSupport::Concern

    SESSION_KEY = :billie_mode
    MODES = %w[default manual].freeze

    # Controllers whose pages belong only to the manual workspace.
    CONTROLLERS = %w[
      finance/manual finance/accounts finance/entries finance/audit_events finance/reviews
      finance/dimensions finance/budgets finance/recurring_rules finance/ledger_reports
    ].freeze

    included do
      before_action :enter_manual_mode
    end

    def self.manual_path?(path)
      route = Rails.application.routes.recognize_path(path.to_s.split("?").first, method: :get)
      CONTROLLERS.include?(route[:controller])
    rescue ActionController::RoutingError
      false
    end

    private

    def enter_manual_mode
      session[SESSION_KEY] = "manual"
    end
  end
end
