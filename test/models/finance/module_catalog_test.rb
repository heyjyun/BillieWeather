require "test_helper"

# The Feature Library catalog contract (packages/shared-types/schema/module-catalog.json), shared with
# the apps (clients/universal/test/modules.test.ts). Both replay the same preference cases.
class Finance::ModuleCatalogTest < ActiveSupport::TestCase
  FIXTURE = JSON.parse(File.read(Rails.root.join("packages/shared-types/fixtures/module-preference-cases.json")))
  CASES = FIXTURE.fetch("cases")

  CASES.each do |example|
    test "shared case: #{example["name"]}" do
      choices = Finance::ModuleCatalog.normalize(example["preferences"])
      order = Finance::ModuleCatalog.normalize_preferences_order(example["preferences"])
      assert_equal example["sidebar"], Finance::ModuleCatalog.sidebar_modules(choices, surface: example["surface"], order: order).map(&:id)
      assert_equal FIXTURE.dig("usable_by_surface", example["surface"]), Finance::ModuleCatalog.enabled_modules(surface: example["surface"]).map(&:id),
        "what can be used never depends on sidebar choices"
    end
  end

  test "the catalog lists the approved modules; two start in the sidebar (catalog version 5)" do
    assert_equal %w[overview ai_assistant transactions accounts fixed_assets categories budgets recurring reports forecast import receipts data_management ledgers goals household multi_currency], Finance::ModuleCatalog::IDS
    assert_equal %w[overview ai_assistant], Finance::ModuleCatalog::MODULES.select(&:default_sidebar_visible).map(&:id)
    refute Finance::ModuleCatalog::MODULES.first.respond_to?(:default_enabled), "sidebar defaults are not called 'enabled'"
    refute_includes Finance::ModuleCatalog::IDS, "settings"
    assert_equal ["settings"], Finance::ModuleCatalog::SCHEMA.fetch("system_entries").map { |entry| entry["id"] }
  end

  test "coming-soon modules have no website page; available ones name a real route" do
    Finance::ModuleCatalog::MODULES.each do |definition|
      if definition.available?
        assert Rails.application.routes.url_helpers.respond_to?("#{definition.route}_path"), "#{definition.id}: #{definition.route}"
      else
        assert_nil definition.route, definition.id
      end
    end
    assert_equal %w[fixed_assets ledgers goals household multi_currency], Finance::ModuleCatalog::MODULES.select(&:coming_soon?).map(&:id)
  end

  test "platform status: built modules are usable everywhere they are built; Forecast is website-only" do
    assert_equal %w[overview ai_assistant transactions accounts categories budgets recurring reports forecast import receipts data_management], Finance::ModuleCatalog.enabled_modules.map(&:id)
    forecast = Finance::ModuleCatalog.find("forecast")
    assert forecast.available?("web")
    assert forecast.unsupported?("app"), "not built in the app: 'unsupported', not 'coming soon' and not switched off"
    refute forecast.coming_soon?("app")
    %w[ledgers goals household multi_currency].each do |id|
      definition = Finance::ModuleCatalog.find(id)
      assert %w[web app].all? { |surface| definition.coming_soon?(surface) }, id
    end
    assert_equal %w[available coming_soon unsupported], Finance::ModuleCatalog::SCHEMA.fetch("availability_states")
  end

  test "removed financial services are not in the catalog" do
    %w[investments investment brokerage loans credit_score payments remittance cards fx_trading].each do |id|
      assert_nil Finance::ModuleCatalog.find(id), id
    end
  end

  test "every finance controller belongs to a module or is a system page" do
    Rails.application.eager_load!
    names = Finance::BaseController.descendants.map(&:controller_name).uniq.sort
    unmapped = names - Finance::ModuleCatalog::CONTROLLER_MODULES.keys - Finance::ModuleCatalog::SYSTEM_CONTROLLERS
    assert_empty unmapped, "map these controllers in Finance::ModuleCatalog::CONTROLLER_MODULES or SYSTEM_CONTROLLERS"
    assert (Finance::ModuleCatalog::CONTROLLER_MODULES.values - Finance::ModuleCatalog::IDS).empty?
    refute_includes Finance::ModuleCatalog::CONTROLLER_MODULES.keys, "settings"
  end

  test "every module icon is drawn by the website helper" do
    helper = Object.new.extend(FinanceHelper, ActionView::Helpers::TagHelper)
    fallback = helper.finance_icon("__unknown__")
    Finance::ModuleCatalog::MODULES.each { |definition| refute_equal fallback, helper.finance_icon(definition.icon), definition.icon }
  end

  test "sidebar choices: an explicit choice wins, coming soon is refused, revision grows, usability never changes" do
    user = create(:onboarded_user, usage_region: "US")
    Finance::ModulePreference.set!(user: user, module_key: "budgets", sidebar_visible: true)
    record = Finance::ModulePreference.set!(user: user, module_key: "budgets", sidebar_visible: false)
    assert_equal [false, 2], [record.sidebar_visible, record.revision]
    assert_equal ["budgets"], Finance::ModulePreference.where(user: user).pluck(:module_key)
    assert_raises(ActiveRecord::RecordInvalid) { Finance::ModulePreference.set!(user: user, module_key: "goals", sidebar_visible: true) }
    assert_raises(ActiveRecord::RecordInvalid) { Finance::ModulePreference.set!(user: user, module_key: "settings", sidebar_visible: false) }
    assert_raises(ActiveRecord::StatementInvalid) do
      Finance::ModulePreference.transaction(requires_new: true) { Finance::ModulePreference.insert_all!([{user_id: user.id, module_key: "BAD KEY", enabled: true, changed_at: Time.current, revision: 1}]) }
    end
    choices = Finance::ModuleCatalog.choices_for(user)
    refute Finance::ModuleCatalog.sidebar_visible?("budgets", choices)
    refute Finance::ModuleCatalog.sidebar_visible?("transactions", choices)
    assert Finance::ModuleCatalog.enabled?("budgets"), "hidden from the sidebar, still usable"
    assert_includes Finance::ModuleCatalog.hidden_modules(choices).map(&:id), "budgets"
  end

  test "rows written before the rename keep their meaning (the column is still `enabled`)" do
    user = create(:onboarded_user, usage_region: "US")
    Finance::ModulePreference.insert_all!([{user_id: user.id, module_key: "reports", enabled: true, changed_at: Time.current, revision: 3, created_at: Time.current, updated_at: Time.current},
      {user_id: user.id, module_key: "ai_assistant", enabled: false, changed_at: Time.current, revision: 1, created_at: Time.current, updated_at: Time.current}])
    choices = Finance::ModuleCatalog.choices_for(user)
    assert_equal %w[overview reports], Finance::ModuleCatalog.sidebar_modules(choices).map(&:id)
    assert_equal 3, choices.dig("reports", "revision")
    assert Finance::ModuleCatalog.enabled?("ai_assistant"), "a hidden module still works"
  end

  test "preferences are per person and go away with the account, not with 'delete my financial data'" do
    user = create(:onboarded_user, usage_region: "US")
    other = create(:onboarded_user, usage_region: "US")
    Finance::ModulePreference.set!(user: user, module_key: "reports", sidebar_visible: true)
    refute Finance::ModuleCatalog.sidebar_visible?("reports", Finance::ModuleCatalog.choices_for(other))
    Finance::DataDeletion.call(user: user)
    assert Finance::ModulePreference.where(user: user).exists?
    user.destroy!
    refute Finance::ModulePreference.where(user_id: user.id).exists?
  end
end
