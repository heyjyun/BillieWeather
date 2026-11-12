module Finance
  # JSON endpoints behind the website's command bar (public/billie-command.js). The browser parses
  # commands itself; these endpoints are the trusted side: signed-in only, CSRF-protected, scoped to
  # current_user, size- and rate-limited. See Finance::SmartCommand::Executor.
  class CommandsController < ApplicationController
    MAX_BODY_BYTES = 64.kilobytes

    before_action :authenticate_user!
    before_action :require_usage_region_json
    before_action :parse_body, except: :context
    after_action { response.headers["Cache-Control"] = "no-store, private" }
    # A body that is not JSON never reaches an action (Rails parses it as soon as params are read).
    rescue_from ActionDispatch::Http::Parameters::ParseError, with: -> { render json: {error: "malformed"}, status: :bad_request }
    rate_limit to: 120, within: 1.minute, by: -> { current_user&.id || request.remote_ip },
      with: -> { render json: {error: "rate_limited"}, status: :too_many_requests }

    # What the browser needs to understand commands: category names (no transactions or amounts),
    # page names, the person's local date and currency, and the plan scope.
    def context
      profile = Profile.find_by(user_id: current_user.id)
      render json: {
        product: SmartCommand::Manifest.current.product,
        tenant: SmartCommand::Executor.tenant_for(current_user),
        today: finance_today.iso8601,
        currency: profile&.currency || "USD",
        builtInCategories: Transaction::CATEGORIES.map do |name|
          {id: name, label: category_label(name), names: I18n.available_locales.map { |locale| I18n.t("billie.backend.categories.#{name}", locale: locale, default: name) }.uniq}
        end,
        customCategories: current_user.finance_custom_categories.order(Arel.sql("lower(name)")).pluck(:name),
        pages: page_labels
      }
    end

    def preview
      render json: executor.preview(@body["plan"])
    end

    def execute
      render json: executor.execute(@body)
    end

    def undo
      render json: executor.undo(@body["token"])
    end

    private

    def executor
      currency = Profile.find_by(user_id: current_user.id)&.currency || "USD"
      SmartCommand::Executor.new(
        user: current_user,
        urls: {pages: page_paths, transactions: ->(params) { finance_transactions_path(params) }},
        money: ->(amount) { helpers.finance_money(amount, currency) },
        category_label: method(:category_label)
      )
    end

    def page_paths
      {
        "dashboard" => finance_dashboard_path, "import" => finance_statements_path, "transactions" => finance_transactions_path,
        "categories" => finance_categories_path, "forecast" => finance_forecast_path, "insights" => finance_insights_path,
        "tax" => finance_tax_preparation_path, "reports" => finance_report_path, "settings" => finance_settings_path
      }
    end

    def page_labels
      {
        "dashboard" => t("billie.layout.dashboard"), "import" => t("billie.layout.statements"), "transactions" => t("billie.layout.transactions"),
        "categories" => t("billie.categories.nav"), "forecast" => t("billie.layout.forecast"), "insights" => t("billie.layout.insights"),
        "tax" => t("billie.layout.tax_preparation"), "reports" => t("billie.export.title"), "settings" => t("billie.region.nav")
      }
    end

    def category_label(name)
      I18n.t("billie.backend.categories.#{name}", default: name)
    end

    # Same date as Finance::BaseController#finance_today, so "this month" matches the pages.
    def finance_today
      Time.current.in_time_zone(current_user.time_zone.presence || "America/Chicago").to_date
    end

    def require_usage_region_json
      render json: {error: "usage_region_required"}, status: :forbidden if current_user.needs_usage_region?
    end

    # The raw JSON body, parsed once; plans are never turned into ActiveRecord or strong params.
    def parse_body
      return render json: {error: "too_large"}, status: :content_too_large if request.content_length.to_i > MAX_BODY_BYTES
      raw = request.raw_post
      return render json: {error: "too_large"}, status: :content_too_large if raw.bytesize > MAX_BODY_BYTES
      @body = JSON.parse(raw)
      render json: {error: "malformed"}, status: :bad_request unless @body.is_a?(Hash)
    rescue JSON::ParserError
      render json: {error: "malformed"}, status: :bad_request
    end
  end
end
