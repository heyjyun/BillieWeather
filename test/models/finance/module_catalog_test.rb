require "test_helper"

# The Feature Library catalog contract (packages/shared-types/schema/module-catalog.json), shared with
# the apps (clients/universal/test/modules.test.ts). Both replay the same preference cases.
class Finance::ModuleCatalogTest < ActiveSupport::TestCase
  CASES = JSON.parse(File.read(Rails.root.join("packages/shared-types/fixtures/module-preference-cases.json"))).fetch("cases")

  CASES.each do |example|
    test "shared case: #{example["name"]}" do
      choices = Finance::ModuleCatalog.normalize(example["preferences"])
      assert_equal example["enabled"], Finance::ModuleCatalog.enabled_modules(choices, surface: example["surface"]).map(&:id)
    end
  end

  test "the catalog lists the approved modules; only Transactions and AI Assistant start on" do
    assert_equal %w[transactions ai_assistant ledgers accounts categories budgets reports recurring goals household forecast multi_currency], Finance::ModuleCatalog::IDS
    assert_equal %w[transactions ai_assistant], Finance::ModuleCatalog::MODULES.select(&:default_enabled).map(&:id)
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
    assert_equal %w[ledgers goals household multi_currency], Finance::ModuleCatalog::MODULES.select(&:coming_soon?).map(&:id)
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

  test "preferences: an explicit choice wins, coming soon is refused, revision grows" do
    user = create(:onboarded_user, usage_region: "US")
    Finance::ModulePreference.set!(user: user, module_key: "budgets", enabled: true)
    record = Finance::ModulePreference.set!(user: user, module_key: "budgets", enabled: false)
    assert_equal [false, 2], [record.enabled, record.revision]
    assert_equal ["budgets"], Finance::ModulePreference.where(user: user).pluck(:module_key)
    assert_raises(ActiveRecord::RecordInvalid) { Finance::ModulePreference.set!(user: user, module_key: "goals", enabled: true) }
    assert_raises(ActiveRecord::RecordInvalid) { Finance::ModulePreference.set!(user: user, module_key: "settings", enabled: false) }
    assert_raises(ActiveRecord::StatementInvalid) do
      Finance::ModulePreference.transaction(requires_new: true) { Finance::ModulePreference.insert_all!([{user_id: user.id, module_key: "BAD KEY", enabled: true, changed_at: Time.current, revision: 1}]) }
    end
    refute Finance::ModuleCatalog.enabled?("budgets", Finance::ModuleCatalog.choices_for(user))
    assert Finance::ModuleCatalog.enabled?("transactions", Finance::ModuleCatalog.choices_for(user))
  end

  test "preferences are per person and go away with the account, not with 'delete my financial data'" do
    user = create(:onboarded_user, usage_region: "US")
    other = create(:onboarded_user, usage_region: "US")
    Finance::ModulePreference.set!(user: user, module_key: "reports", enabled: true)
    refute Finance::ModuleCatalog.enabled?("reports", Finance::ModuleCatalog.choices_for(other))
    Finance::DataDeletion.call(user: user)
    assert Finance::ModulePreference.where(user: user).exists?
    user.destroy!
    refute Finance::ModulePreference.where(user_id: user.id).exists?
  end
end
