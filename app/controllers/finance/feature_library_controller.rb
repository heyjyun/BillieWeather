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
      ModulePreference.set!(user: current_user, module_key: definition.id, enabled: enabled == true)
      @module_choices = nil
      message = t(enabled ? "billie.modules.library.saved_on" : "billie.modules.library.saved_off", name: module_name(definition))
      respond_to do |format|
        format.json do
          render json: {module: definition.id, enabled: module_enabled?(definition.id), message: message,
                        nav: render_to_string(partial: "finance/shared/module_nav", formats: [:html])}
        end
        format.html { redirect_to return_path || finance_feature_library_path(filter: params[:filter].presence_in(FILTERS)), status: :see_other, notice: message }
      end
    end

    private

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
