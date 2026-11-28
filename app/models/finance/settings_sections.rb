module Finance
  # The website's Settings sections, in order: one entry per panel on finance/settings/show, so the
  # page index is generated instead of hard-coded. Add a panel by adding an entry here (and its partial
  # or block on the page); `module` ties a section to a Feature Library module, shown only while that
  # module is usable on the website. The apps keep the same areas in
  # clients/universal/src/settings/registry.tsx.
  module SettingsSections
    Section = Data.define(:id, :area, :title_key, :module_id) do
      def anchor = "settings-#{id.tr("_", "-")}"
    end

    ALL = [
      Section.new(id: "feature_library", area: "features", title_key: "billie.modules.library.management", module_id: nil),
      Section.new(id: "sidebar", area: "features", title_key: "billie.modules.sidebar.title", module_id: nil),
      Section.new(id: "automation", area: "automation", title_key: "billie.settings_hub.automation", module_id: nil),
      Section.new(id: "rules", area: "automation", title_key: "billie.settings_hub.rules", module_id: "categories"),
      Section.new(id: "data_tools", area: "data", title_key: "billie.settings_hub.data_tools", module_id: nil),
      Section.new(id: "appearance", area: "appearance", title_key: "billie.settings_hub.appearance", module_id: nil),
      Section.new(id: "profile", area: "account", title_key: "billie.account.profile_heading", module_id: nil),
      Section.new(id: "community", area: "account", title_key: "billie.community.settings.heading", module_id: nil),
      Section.new(id: "password", area: "account", title_key: "billie.account.password_heading", module_id: nil),
      Section.new(id: "sessions", area: "account", title_key: "billie.account.sessions_heading", module_id: nil),
      Section.new(id: "region", area: "account", title_key: "billie.region.label", module_id: nil),
      Section.new(id: "sync_backup", area: "database", title_key: "billie.settings_hub.sync_backup", module_id: nil),
      Section.new(id: "database", area: "database", title_key: "billie.settings_hub.database", module_id: nil),
      Section.new(id: "privacy", area: "data", title_key: "billie.privacy.heading", module_id: nil)
    ].freeze

    module_function

    def visible = ALL.select { |section| section.module_id.nil? || ModuleCatalog.enabled?(section.module_id) }
  end
end
