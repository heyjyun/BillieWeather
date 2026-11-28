require "test_helper"

# Settings › Sidebar customization: the saved sidebar order (Finance::SidebarOrder) and how the
# catalog applies it (Finance::ModuleCatalog.order_sidebar). The cases shared with the apps are
# replayed in module_catalog_test.rb; this covers storage, revisions and restore.
class Finance::SidebarOrderTest < ActiveSupport::TestCase
  setup { @user = create(:onboarded_user, usage_region: "US") }

  def sidebar(user = @user)
    Finance::ModuleCatalog.sidebar_modules(Finance::ModuleCatalog.choices_for(user), order: Finance::SidebarOrder.keys_for(user)).map(&:id)
  end

  test "a new account has the two default entries in catalog order and no saved order" do
    assert_equal [], Finance::SidebarOrder.keys_for(@user)
    assert_equal 0, Finance::SidebarOrder.revision_for(@user)
    assert_equal %w[overview ai_assistant], sidebar
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
    assert_equal %w[overview ai_assistant], sidebar
  end

  test "sparse visibility and order-only accounts inherit every missing choice" do
    fresh = create(:onboarded_user, usage_region: "US")
    order_only = create(:onboarded_user, usage_region: "US")
    saved = Finance::SidebarOrder.set!(user: order_only, module_keys: %w[categories accounts transactions])
    hidden = Finance::ModulePreference.set!(user: @user, module_key: "overview", sidebar_visible: false)
    Finance::ModulePreference.set!(user: @user, module_key: "reports", sidebar_visible: true)

    assert_equal %w[ai_assistant reports], sidebar
    assert_equal %w[overview ai_assistant], sidebar(order_only)
    assert_equal %w[overview ai_assistant], sidebar(fresh)
    assert_empty Finance::ModulePreference.where(user: order_only)
    assert_equal %w[categories accounts transactions], saved.reload.module_keys
    assert_equal 1, saved.revision
    assert_equal [false, 1], [hidden.reload.sidebar_visible, hidden.revision]
    assert_empty Finance::ModulePreference.where(user: fresh)
    Finance::ModulePreference.restore_sidebar_defaults!(user: order_only)
    assert_equal %w[overview ai_assistant], sidebar(order_only)
  end

  test "only untouched inserts from the historical backfill inherit the catalog" do
    Finance::SidebarOrder.set!(user: @user, module_keys: %w[categories accounts transactions])
    Finance::ModulePreference.set!(user: @user, module_key: "transactions", sidebar_visible: true)
    # Reproduce the original migration transaction inside this rolled-back test, including its
    # version record. Orders and a real explicit choice must remain independently effective.
    require Rails.root.join("db/migrate/20261128000200_preserve_personalized_sidebar_visibility")
    connection = Finance::ModulePreference.connection
    connection.execute(<<~SQL)
      INSERT INTO schema_migrations (version) VALUES ('20261128000200')
      ON CONFLICT (version) DO UPDATE SET version = EXCLUDED.version
    SQL
    PreservePersonalizedSidebarVisibility.new.up
    assert_equal %w[transactions overview ai_assistant], sidebar
    snapshot = Finance::ModulePreferenceSync.new(@user).snapshot
    assert_equal true, snapshot.dig(:modules, "categories", :inherits_default)
    assert_equal false, snapshot.dig(:modules, "categories", :sidebar_visible)
    assert_equal 1, snapshot.dig(:modules, "categories", :revision)
    Finance::ModulePreference.set!(user: @user, module_key: "categories", sidebar_visible: true, expected_revision: 1)
    assert_equal %w[categories transactions overview ai_assistant], sidebar
    refute Finance::ModulePreference.for_sidebar(@user).find_by!(module_key: "categories").inherited_sidebar_choice?
  end

  test "a saved order is applied, each revision checked, and a stale write refused" do
    Finance::SidebarOrder.set!(user: @user, module_keys: %w[accounts ai_assistant], expected_revision: 0)
    assert_equal %w[ai_assistant overview], sidebar
    assert_equal 1, Finance::SidebarOrder.revision_for(@user)
    assert_raises(Finance::ModulePreferenceSync::StaleChoice) do
      Finance::SidebarOrder.set!(user: @user, module_keys: %w[categories], expected_revision: 0)
    end
    assert_equal %w[accounts ai_assistant], Finance::SidebarOrder.keys_for(@user)
  end

  test "unknown and duplicate ids are dropped; the database refuses anything but an array" do
    Finance::SidebarOrder.set!(user: @user, module_keys: %w[budgets crypto_wallets budgets overview])
    assert_equal %w[budgets overview], Finance::SidebarOrder.keys_for(@user)
    # budgets is hidden, so the saved id adds no entry
    assert_equal %w[overview ai_assistant], sidebar
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
    assert_equal %w[overview ai_assistant], sidebar
    assert_equal %w[accounts], Finance::SidebarOrder.keys_for(other)
  end
end
