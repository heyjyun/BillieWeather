require "test_helper"

# Settings › Sidebar customization: the saved sidebar order (Finance::SidebarOrder) and how the
# catalog applies it (Finance::ModuleCatalog.order_sidebar). The cases shared with the apps are
# replayed in module_catalog_test.rb; this covers storage, revisions and restore.
class Finance::SidebarOrderTest < ActiveSupport::TestCase
  setup { @user = create(:onboarded_user, usage_region: "US") }

  def sidebar(user = @user)
    Finance::ModuleCatalog.sidebar_modules(Finance::ModuleCatalog.choices_for(user), order: Finance::SidebarOrder.keys_for(user)).map(&:id)
  end

  test "a new account has the five default entries in catalog order and no saved order" do
    assert_equal [], Finance::SidebarOrder.keys_for(@user)
    assert_equal 0, Finance::SidebarOrder.revision_for(@user)
    assert_equal %w[transactions ai_assistant overview categories accounts], sidebar
  end

  test "adding the order table preserves existing explicit visibility choices" do
    require Rails.root.join("db/migrate/20261128000100_create_finance_sidebar_orders.rb").to_s
    preference = Finance::ModulePreference.set!(user: @user, module_key: "accounts", sidebar_visible: false)
    migration = CreateFinanceSidebarOrders.new
    migration.verbose = false

    migration.migrate(:down)
    refute Finance::SidebarOrder.connection.table_exists?(:finance_sidebar_orders)
    migration.migrate(:up)
    assert_equal false, preference.reload.sidebar_visible
    assert_equal 1, preference.revision
    assert_equal %w[transactions ai_assistant overview categories], sidebar
  end

  test "a saved order is applied, each revision checked, and a stale write refused" do
    Finance::SidebarOrder.set!(user: @user, module_keys: %w[accounts transactions], expected_revision: 0)
    assert_equal %w[accounts transactions ai_assistant overview categories], sidebar
    assert_equal 1, Finance::SidebarOrder.revision_for(@user)
    assert_raises(Finance::ModulePreferenceSync::StaleChoice) do
      Finance::SidebarOrder.set!(user: @user, module_keys: %w[categories], expected_revision: 0)
    end
    assert_equal %w[accounts transactions], Finance::SidebarOrder.keys_for(@user)
  end

  test "unknown and duplicate ids are dropped; the database refuses anything but an array" do
    Finance::SidebarOrder.set!(user: @user, module_keys: %w[budgets crypto_wallets budgets overview])
    assert_equal %w[budgets overview], Finance::SidebarOrder.keys_for(@user)
    # budgets is hidden, so the saved id adds no entry
    assert_equal %w[overview transactions ai_assistant categories accounts], sidebar
    assert_raises(ActiveRecord::StatementInvalid) do
      Finance::SidebarOrder.connection.execute("UPDATE finance_sidebar_orders SET module_keys = '{}'::jsonb WHERE user_id = #{@user.id}")
    end
  end

  test "restoring the default sidebar also restores the default order, and leaves other accounts alone" do
    other = create(:onboarded_user, usage_region: "US")
    Finance::SidebarOrder.set!(user: other, module_keys: %w[accounts])
    Finance::SidebarOrder.set!(user: @user, module_keys: %w[accounts])
    Finance::ModulePreference.set!(user: @user, module_key: "budgets", sidebar_visible: true)
    Finance::ModulePreference.restore_sidebar_defaults!(user: @user)
    assert_equal [], Finance::SidebarOrder.keys_for(@user)
    assert_equal 2, Finance::SidebarOrder.revision_for(@user)
    assert_equal %w[transactions ai_assistant overview categories accounts], sidebar
    assert_equal %w[accounts], Finance::SidebarOrder.keys_for(other)
  end
end
