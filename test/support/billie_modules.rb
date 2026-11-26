# Feature Library: every available module works for every account; only the sidebar is personal
# (Transactions and AI Assistant by default). Tests that look at the sidebar with more modules in it
# add them the way a person would in Settings › Feature Library. A test never needs to "turn a module
# on" to use its pages. The default sidebar itself is covered by test/integration/finance_feature_library_test.rb.
module BillieModules
  def show_in_sidebar!(user, ids = Finance::ModuleCatalog::MODULES.select(&:available?).map(&:id), visible: true)
    Array(ids).each { |id| Finance::ModulePreference.set!(user: user, module_key: id, sidebar_visible: visible) }
    user
  end

  def hide_from_sidebar!(user, ids) = show_in_sidebar!(user, ids, visible: false)

  # Asserts the response is the module's real page (its sidebar entry does not matter).
  def assert_module_page(module_id)
    assert_response :success
    assert_select "#module-disabled", {count: 0}, "#{module_id}: no page is ever replaced by a \"turned off\" page"
  end

  # Include in an integration test class: everyone it signs in has every available module in the sidebar.
  module SignInWithFullSidebar
    def sign_in(resource, *args, **kwargs)
      show_in_sidebar!(resource) if resource.is_a?(User) && resource.persisted?
      super
    end

    def post(path, **options)
      if path.to_s == "/users/sign_in" && (email = options.dig(:params, :user, :email))
        user = User.find_by(email: email)
        show_in_sidebar!(user) if user
      end
      super
    end
  end
end

ActiveSupport::TestCase.include(BillieModules)
ActionDispatch::IntegrationTest.include(BillieModules)
