require "json"

module Finance
  # The Feature Library catalog (Settings › Feature Library), read from
  # packages/shared-types/schema/module-catalog.json — the same file the apps import
  # (packages/shared-types/src/modules.ts). Both sides resolve preferences with the same rules and
  # replay packages/shared-types/fixtures/module-preference-cases.json:
  #
  # - A module can be on only when it is "available" on the website; "coming_soon" modules are listed
  #   but never enabled, whatever was stored.
  # - Without a stored choice a module uses its default (Transactions and AI Assistant on, the rest off),
  #   for new and existing accounts alike (product decision 1, 2026-11-23).
  # - Settings is a system entry, not a module: always shown, never stored.
  # - Hiding a module only hides it: data, processing (recurring posting, receipt matching, balance
  #   sync) and permissions are unchanged.
  module ModuleCatalog
    PATH = Rails.root.join("packages/shared-types/schema/module-catalog.json")
    SCHEMA = JSON.parse(File.read(PATH)).freeze
    SURFACE = "web"
    PREFERENCE_FORMAT = SCHEMA.fetch("preference_format")
    ID_FORMAT = /\A[a-z_]{2,40}\z/

    Definition = Data.define(:id, :core, :default_enabled, :order, :icon, :availability, :destination, :depends_on) do
      def available?(surface = SURFACE) = availability.fetch(surface) == "available"

      def coming_soon?(surface = SURFACE) = !available?(surface)

      # The website route helper name, or nil when the module has no page here.
      def route = destination[SURFACE]
    end

    MODULES = SCHEMA.fetch("modules").map do |raw|
      Definition.new(id: raw.fetch("id"), core: raw.fetch("core"), default_enabled: raw.fetch("default_enabled"), order: raw.fetch("order"),
        icon: raw.fetch("icon"), availability: raw.fetch("availability").freeze, destination: raw.fetch("destination").freeze, depends_on: raw.fetch("depends_on").freeze)
    end.sort_by(&:order).freeze
    IDS = MODULES.map(&:id).freeze

    # Which module each finance controller belongs to. Controllers not listed are system pages
    # (settings, profile, mode switch, command bar, device metadata, financial data deletion) and are
    # never hidden. A test checks every Finance controller is either here or in SYSTEM_CONTROLLERS.
    CONTROLLER_MODULES = {
      "dashboard" => "transactions", "transactions" => "transactions", "statements" => "transactions",
      "statement_drafts" => "transactions", "receipts" => "transactions", "reconciliation" => "transactions",
      "manual" => "transactions", "entries" => "transactions", "audit_events" => "transactions",
      "reviews" => "transactions", "add_sync" => "transactions",
      "insights" => "ai_assistant", "tax_preparation" => "ai_assistant",
      "accounts" => "accounts",
      "categories" => "categories", "dimensions" => "categories",
      "budgets" => "budgets",
      "ledger_reports" => "reports", "reports" => "reports",
      "recurring_rules" => "recurring",
      "forecast" => "forecast"
    }.freeze
    # Website pages of modules with more than one page, shown as tabs above the page:
    # [label translation key, route helper, controllers that mark the tab active].
    WEB_TABS = {
      "ai_assistant" => [["billie.layout.insights", "finance_insights", %w[insights]], ["billie.layout.tax_preparation", "finance_tax_preparation", %w[tax_preparation]]],
      "reports" => [["billie.ledger.report.title", "finance_ledger_report", %w[ledger_reports]], ["billie.export.title", "finance_report", %w[reports]]],
      "categories" => [["billie.categories.nav", "finance_categories", %w[categories]], ["billie.ledger.nav.lists", "finance_dimension_index", %w[dimensions]]]
    }.freeze
    SYSTEM_CONTROLLERS = %w[base settings feature_library profiles financial_data local_devices modes commands bank_accounts capture_tokens].freeze

    module_function

    def find(id) = MODULES.find { |definition| definition.id == id.to_s }

    def module_for_controller(controller_name) = CONTROLLER_MODULES[controller_name.to_s]

    # Stored choices for a person: {"budgets" => {"enabled" => true, "changedAt" => "..."}}.
    def choices_for(user)
      ModulePreference.where(user_id: user.id).to_h { |row| [row.module_key, {"enabled" => row.enabled, "changedAt" => row.changed_at&.utc&.iso8601(3).to_s, "revision" => row.revision}] }
    end

    # Same contract as normalizePreferences in modules.ts: bad data means "no choice", never an error.
    def normalize(preferences)
      return {} unless preferences.is_a?(Hash) && preferences["format"] == PREFERENCE_FORMAT && preferences["modules"].is_a?(Hash)
      preferences["modules"].each_with_object({}) do |(id, choice), result|
        next unless id.is_a?(String) && id.match?(ID_FORMAT) && choice.is_a?(Hash) && [true, false].include?(choice["enabled"])
        result[id] = {"enabled" => choice["enabled"], "changedAt" => choice["changedAt"].is_a?(String) ? choice["changedAt"] : ""}
      end
    end

    def enabled?(id, choices, surface: SURFACE)
      definition = find(id)
      return false unless definition&.available?(surface)
      choice = choices[definition.id]
      choice ? choice["enabled"] == true : definition.default_enabled
    end

    def enabled_modules(choices, surface: SURFACE) = MODULES.select { |definition| enabled?(definition.id, choices, surface: surface) }
  end
end
