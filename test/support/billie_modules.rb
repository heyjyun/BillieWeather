# Feature Library (Phase 1a): optional modules are hidden by default for everyone. Tests that exercise
# an optional module's pages (Accounts, Categories, Budgets, Reports, Recurring, Forecast) turn the
# modules on for the people they sign in, the way a person would in Settings › Feature Library.
# The default navigation itself is covered by test/integration/finance_feature_library_test.rb.
module BillieModules
  def enable_modules!(user, ids = Finance::ModuleCatalog::MODULES.select(&:available?).map(&:id))
    Array(ids).each { |id| Finance::ModulePreference.set!(user: user, module_key: id, enabled: true) }
    user
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
