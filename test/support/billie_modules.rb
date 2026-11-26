# Feature Library (Phase 1a): optional modules are hidden by default for everyone. Tests that exercise
# an optional module's pages (Accounts, Categories, Budgets, Reports, Recurring, Forecast) turn the
# modules on for the people they sign in, the way a person would in Settings › Feature Library.
# The default navigation itself is covered by test/integration/finance_feature_library_test.rb.
module BillieModules
  def enable_modules!(user, ids = Finance::ModuleCatalog::MODULES.select(&:available?).map(&:id))
    Array(ids).each { |id| Finance::ModulePreference.set!(user: user, module_key: id, enabled: true) }
    user
  end

  # Asserts the response is the module's real page. A turned-off module answers 200 with the
  # "turned off" page (Finance::BaseController#require_enabled_module), so assert_response :success
  # alone cannot tell a hidden module from a working page; this says which one it was.
  def assert_module_page(module_id)
    assert_response :success
    disabled = css_select("#module-disabled").first
    return pass unless disabled
    flunk "Expected the #{module_id} page, but the \"#{disabled["data-module"]}\" module is turned off for this account " \
      "(Feature Library: optional modules are off by default). Turn it on with enable_modules!(user, #{module_id.inspect}) " \
      "or include BillieModules::SignInWithAllModules. This is not a missing feature."
  end

  # Asserts the response is the "turned off" page for `module_id` (the person can turn it on there).
  def assert_module_disabled(module_id)
    assert_response :success
    assert_select "#module-disabled[data-module=?]", module_id.to_s
  end

  # Include in an integration test class: everyone it signs in has every available module on.
  module SignInWithAllModules
    def sign_in(resource, *args, **kwargs)
      enable_modules!(resource) if resource.is_a?(User) && resource.persisted?
      super
    end

    def post(path, **options)
      if path.to_s == "/users/sign_in" && (email = options.dig(:params, :user, :email))
        user = User.find_by(email: email)
        enable_modules!(user) if user
      end
      super
    end
  end
end

ActiveSupport::TestCase.include(BillieModules)
ActionDispatch::IntegrationTest.include(BillieModules)
