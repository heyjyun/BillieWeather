require "json"

module Finance
  # The Feature Library catalog (Settings › Feature Library), read from
  # packages/shared-types/schema/module-catalog.json — the same file the apps import
  # (packages/shared-types/src/modules.ts). Both sides resolve preferences with the same rules and
  # replay packages/shared-types/fixtures/module-preference-cases.json. Three separate questions:
  #
  # - Availability per surface: "available" (built, works here), "coming_soon" (not built yet) or
  #   "unsupported" (built on another surface only).
  # - Enabled = can be used. Derived, never stored: every module available on the website is enabled
  #   for every account, new or existing. No personal choice disables a feature.
  # - Sidebar visibility: a personal choice. Without one, the catalog default applies (Financial Overview and AI Insight).
  # - Sidebar order: a personal choice too, one saved list per account (Finance::SidebarOrder). Entries
  #   the list does not name follow it in catalog order (order_sidebar), as in modules.ts.
  #
  # Settings is a system entry, not a module: always shown, never stored. Hiding a module from the
  # sidebar never blocks its pages, changes data or stops processing (recurring posting, receipt
  # matching, balance sync); every authorization check still runs.
  module ModuleCatalog
    PATH = Rails.root.join("packages/shared-types/schema/module-catalog.json")
    SCHEMA = JSON.parse(File.read(PATH)).freeze
    SURFACE = "web"
    PREFERENCE_FORMAT = SCHEMA.fetch("preference_format")
    GROUPS = SCHEMA.fetch("groups").freeze
    ID_FORMAT = /\A[a-z_]{2,40}\z/

    Definition = Data.define(:id, :group, :default_sidebar_visible, :order, :icon, :availability, :destination, :depends_on) do
      def availability_on(surface = SURFACE) = availability.fetch(surface)

      def available?(surface = SURFACE) = availability_on(surface) == "available"

      # Can be used here. Same as available?: there is no personal "off" switch for a feature.
      def enabled?(surface = SURFACE) = available?(surface)

      def coming_soon?(surface = SURFACE) = availability_on(surface) == "coming_soon"

      # Built, but only on another surface (e.g. Forecast is website-only for now).
      def unsupported?(surface = SURFACE) = availability_on(surface) == "unsupported"

      # The website route helper name, or nil when the module has no page here.
      def route = destination[SURFACE]
    end

    MODULES = SCHEMA.fetch("modules").map do |raw|
      Definition.new(id: raw.fetch("id"), group: raw.fetch("group"), default_sidebar_visible: raw.fetch("default_sidebar_visible"), order: raw.fetch("order"),
        icon: raw.fetch("icon"), availability: raw.fetch("availability").freeze, destination: raw.fetch("destination").freeze, depends_on: raw.fetch("depends_on").freeze)
    end.sort_by(&:order).freeze
    IDS = MODULES.map(&:id).freeze

    # Which module each finance controller belongs to. Controllers not listed are system pages
    # (settings, profile, mode switch, command bar, device metadata, financial data deletion) and are
    # never hidden. A test checks every Finance controller is either here or in SYSTEM_CONTROLLERS.
    TRANSACTION_MODULES = %w[transactions overview import receipts].freeze

    CONTROLLER_MODULES = {
      "dashboard" => "overview", "transactions" => "transactions", "statements" => "import",
      "statement_drafts" => "import", "receipts" => "receipts", "reconciliation" => "receipts",
      "manual" => "transactions", "entries" => "transactions", "audit_events" => "transactions",
      "reviews" => "transactions", "add_sync" => "transactions",
      "insights" => "ai_assistant", "tax_preparation" => "ai_assistant",
      "accounts" => "accounts",
      "categories" => "categories", "category_proposals" => "categories", "dimensions" => "categories",
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

    # Stored sidebar choices for a person: {"budgets" => {"sidebar_visible" => true, "changedAt" => "...", "revision" => 2}}.
    def choices_for(user)
      ModulePreference.for_sidebar(user).to_h { |row| [row.module_key, {"sidebar_visible" => row.effective_sidebar_visible, "changedAt" => row.changed_at&.utc&.iso8601(3).to_s, "revision" => row.revision}] }
    end

    # Same contract as normalizePreferences in modules.ts: bad data means "no choice", never an error.
    # The legacy key "enabled" is read as the sidebar choice it always was.
    def normalize(preferences)
      return {} unless preferences.is_a?(Hash) && preferences["format"] == PREFERENCE_FORMAT && preferences["modules"].is_a?(Hash)
      preferences["modules"].each_with_object({}) do |(id, choice), result|
        next unless id.is_a?(String) && id.match?(ID_FORMAT) && choice.is_a?(Hash)
        visible = choice["sidebarVisible"]
        visible = choice["enabled"] unless [true, false].include?(visible)
        next unless [true, false].include?(visible)
        result[id] = {"sidebar_visible" => visible, "changedAt" => choice["changedAt"].is_a?(String) ? choice["changedAt"] : ""}
      end
    end

    # The saved order in a preferences document (format 1, optional "order"), as normalizeOrder does.
    def normalize_preferences_order(preferences)
      return [] unless preferences.is_a?(Hash) && preferences["format"] == PREFERENCE_FORMAT
      normalize_order(preferences["order"])
    end

    # Whether the module can be used on this surface. Independent of the sidebar.
    def enabled?(id, surface: SURFACE) = find(id)&.enabled?(surface) == true

    def enabled_modules(surface: SURFACE) = MODULES.select { |definition| definition.enabled?(surface) }

    # Whether the module has a sidebar entry for this person.
    def sidebar_visible?(id, choices, surface: SURFACE)
      definition = find(id)
      return false unless definition&.available?(surface)
      choice = choices[definition.id]
      choice ? choice["sidebar_visible"] == true : definition.default_sidebar_visible
    end

    # The sidebar entries in the person's order: ids in `order` first (each once, only shown entries),
    # then the other shown modules in catalog order. Same rules as sidebarModules in modules.ts.
    def sidebar_modules(choices, surface: SURFACE, order: [])
      order_sidebar(MODULES.select { |definition| sidebar_visible?(definition.id, choices, surface: surface) }, order)
    end

    def order_sidebar(definitions, order)
      remaining = definitions.index_by(&:id)
      placed = normalize_order(order).filter_map { |id| remaining.delete(id) }
      placed + definitions.select { |definition| remaining.key?(definition.id) }
    end

    # Known module ids only, each once; anything else (not an array, unknown ids) is dropped.
    def normalize_order(value)
      return [] unless value.is_a?(Array)
      value.select { |id| id.is_a?(String) && find(id) }.uniq
    end

    # Usable modules that are not in the sidebar (opened from the Feature Library).
    def hidden_modules(choices, surface: SURFACE) = MODULES.select { |definition| definition.available?(surface) && !sidebar_visible?(definition.id, choices, surface: surface) }
  end
end
