module Finance
  # Settings › Feature Library: every BillieWeather module, its availability here, a way to open it,
  # and whether it shows in the sidebar (Finance::ModuleCatalog). Only the sidebar changes; every
  # available module keeps working while hidden, and no financial record is read for writing,
  # changed or deleted. JSON requests (the switches, without a page reload) get the new sidebar back.
  class FeatureLibraryController < BaseController
    skip_before_action :load_finance_profile

    FILTERS = %w[all sidebar hidden unavailable].freeze

    def show
      @filter = params[:filter].presence_in(FILTERS) || "all"
    end

    def reset
      ModulePreference.restore_sidebar_defaults!(user: current_user)
      redirect_to library_path, status: :see_other, notice: t("billie.modules.library.reset_saved")
    end

    # Settings › Sidebar customization: saves the order of the sidebar entries. Either the whole list
    # (`module_keys[]`, from a drag) or one step (`move` + `direction`, the buttons that work without
    # JavaScript). Ids must be modules available here, each once; entries left out keep their place
    # after the named ones (ModuleCatalog.order_sidebar).
    def reorder
      current = sidebar_modules.map(&:id)
      keys = params[:move].present? ? moved(current, params[:move].to_s, params[:direction].to_s) : Array(params[:module_keys]).map(&:to_s)
      return refuse(:invalid, :unprocessable_entity) unless keys&.all? { |id| ModuleCatalog.find(id)&.available? } && keys.uniq.length == keys.length

      expected = Integer(params[:expected_revision].to_s, exception: false) if params.key?(:expected_revision)
      SidebarOrder.set!(user: current_user, module_keys: keys, expected_revision: expected)
      render_order(t("billie.modules.sidebar.saved"))
    rescue ModulePreferenceSync::StaleChoice
      render_order(t("billie.modules.sidebar.stale"), conflict: true)
    end

    def update
      definition = ModuleCatalog.find(params[:id])
      return refuse(:unknown, :not_found) unless definition
      return refuse(:not_available, :unprocessable_entity, definition) unless definition.available?
      visible = requested_visibility
      return refuse(:invalid, :unprocessable_entity, definition) if visible.nil?
      expected = nil
      if ModulePreferenceSync.enabled?
        expected = Integer(params[:expected_revision].to_s, exception: false)
        raise ModulePreferenceSync::StaleChoice unless expected && (0..ModulePreferenceSync::MAX_REVISION).cover?(expected)
      end
      ModulePreference.set!(user: current_user, module_key: definition.id, sidebar_visible: visible, expected_revision: expected)
      render_choice(definition, t(visible ? "billie.modules.library.saved_shown" : "billie.modules.library.saved_hidden", name: module_name(definition)))
    rescue ModulePreferenceSync::StaleChoice
      render_choice(definition, t("billie.modules.library.stale"), conflict: true)
    end

    private

    def library_path
      return finance_settings_path(anchor: "settings-sidebar") if params[:settings] == "sidebar"
      return finance_settings_path(anchor: "settings-feature-library") if params[:settings] == "1"

      finance_feature_library_path(filter: params[:filter].presence_in(FILTERS))
    end

    # `sidebar_visible`; `enabled` is the name forms and scripts used before 2026-11-26.
    def requested_visibility
      raw = params.key?(:sidebar_visible) ? params[:sidebar_visible] : params[:enabled]
      case raw
      when true, "true", "1" then true
      when false, "false", "0" then false
      end
    end

    def render_choice(definition, message, conflict: false)
      respond_to do |format|
        format.json do
          read_sidebar_snapshot
          render json: {module: definition.id, sidebar_visible: module_in_sidebar?(definition.id), revision: module_revision(definition.id),
                        message: message, **sidebar_fragments},
            status: conflict ? :conflict : :ok
        end
        format.html do
          path = library_path
          if conflict
            redirect_to path, status: :see_other, alert: message
          else
            redirect_to return_path || path, status: :see_other, notice: message
          end
        end
      end
    end

    # One step up or down in the current sidebar; nil for an id that is not in it or a bad direction.
    def moved(current, id, direction)
      index = current.index(id)
      return nil unless index && %w[up down].include?(direction)
      target = (direction == "up") ? index - 1 : index + 1
      return current unless target.between?(0, current.length - 1)
      current.dup.tap { |list| list[index], list[target] = list[target], list[index] }
    end

    def render_order(message, conflict: false)
      respond_to do |format|
        format.json do
          read_sidebar_snapshot
          render json: {order: sidebar_modules.map(&:id), revision: sidebar_order_revision, message: message, **sidebar_fragments},
            status: conflict ? :conflict : :ok
        end
        format.html { redirect_to finance_settings_path(anchor: "settings-sidebar"), status: :see_other, flash: {(conflict ? :alert : :notice) => message} }
      end
    end

    # Read under the same account lock used by web and device writes. All fragments then
    # describe exactly the revision used to discard out-of-order responses in the browser.
    def read_sidebar_snapshot
      current_user.with_lock do
        @module_choices = ModuleCatalog.choices_for(current_user)
        order = SidebarOrder.find_by(user_id: current_user.id)
        @sidebar_order = order&.module_keys || []
        @sidebar_order_revision = order&.revision || 0
      end
    end

    def sidebar_fragments
      {sidebar_revision: module_choices.values.sum { |choice| choice.fetch("revision") } + sidebar_order_revision,
       nav: render_to_string(partial: "finance/shared/module_nav", formats: [:html]),
       customization: render_to_string(partial: "finance/feature_library/sidebar_customization", formats: [:html]),
       preview: render_to_string(partial: "finance/feature_library/sidebar_preview", formats: [:html])}
    end

    # "Show in sidebar" from another page returns there. Only this app's own pages (no host, no scheme).
    def return_path
      path = params[:return_to].to_s
      path if path.match?(%r{\A/app(/[\w\-/]*)?(\?[\w\-=&%.]*)?\z}) && !path.include?("//")
    end

    def module_name(definition) = t("billie.modules.names.#{definition.id}")

    def refuse(code, status, definition = nil)
      message = t("billie.modules.library.errors.#{code}", name: definition && module_name(definition))
      respond_to do |format|
        format.json { render json: {error: code, message: message}, status: status }
        format.html { redirect_to library_path, status: :see_other, alert: message }
      end
    end
  end
end
