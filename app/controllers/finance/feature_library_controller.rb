module Finance
  # Settings › Feature Library: turn product modules on or off (Finance::ModuleCatalog). Only the
  # sidebar and page access change; no financial record is read for writing, changed or deleted.
  # JSON requests (the switches, without a page reload) get the new sidebar back.
  class FeatureLibraryController < BaseController
    FILTERS = %w[all enabled available coming_soon].freeze

    def show
      @filter = params[:filter].presence_in(FILTERS) || "all"
      @modules = ModuleCatalog::MODULES
    end

    def update
      definition = ModuleCatalog.find(params[:id])
      return refuse(:unknown, :not_found) unless definition
      return refuse(:coming_soon, :unprocessable_entity, definition) unless definition.available?
      enabled = ActiveModel::Type::Boolean.new.cast(params[:enabled])
      expected = nil
      if ModulePreferenceSync.enabled?
        expected = Integer(params[:expected_revision].to_s, exception: false)
        raise ModulePreferenceSync::StaleChoice unless expected && (0..ModulePreferenceSync::MAX_REVISION).cover?(expected)
      end
      ModulePreference.set!(user: current_user, module_key: definition.id, enabled: enabled == true, expected_revision: expected)
      render_choice(definition, t(enabled ? "billie.modules.library.saved_on" : "billie.modules.library.saved_off", name: module_name(definition)))
    rescue ModulePreferenceSync::StaleChoice
      render_choice(definition, t("billie.modules.library.stale"), conflict: true)
    end

    private

    def render_choice(definition, message, conflict: false)
      @module_choices = nil
      respond_to do |format|
        format.json do
          render json: {module: definition.id, enabled: module_enabled?(definition.id), revision: module_revision(definition.id),
                        message: message, nav: render_to_string(partial: "finance/shared/module_nav", formats: [:html])},
            status: conflict ? :conflict : :ok
        end
        format.html do
          path = finance_feature_library_path(filter: params[:filter].presence_in(FILTERS))
          if conflict
            redirect_to path, status: :see_other, alert: message
          else
            redirect_to return_path || path, status: :see_other, notice: message
          end
        end
      end
    end

    # "Turn on" from a hidden page returns there. Only this app's own pages (no host, no scheme).
    def return_path
      path = params[:return_to].to_s
      path if path.match?(%r{\A/app(/[\w\-/]*)?(\?[\w\-=&%.]*)?\z}) && !path.include?("//")
    end

    def module_name(definition) = t("billie.modules.names.#{definition.id}")

    def refuse(code, status, definition = nil)
      message = t("billie.modules.library.errors.#{code}", name: definition && module_name(definition))
      respond_to do |format|
        format.json { render json: {error: code, message: message}, status: status }
        format.html { redirect_to finance_feature_library_path, status: :see_other, alert: message }
      end
    end
  end
end
