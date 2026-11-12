require "test_helper"
require "tempfile"
require_relative "../support/billie_method_stub"

# The website's command bar, trusted side (Finance::CommandsController, Finance::SmartCommand).
# Plans come from test/fixtures/files/smart_command/web_plans.json: the real shared parser's output
# for each phrase (kept fresh by packages/billie-commands/test/webPlans.test.ts).
class FinanceSmartCommandTest < ActionDispatch::IntegrationTest
  include Devise::Test::IntegrationHelpers
  include BillieMethodStub

  PLANS = JSON.parse(File.read(Rails.root.join("test/fixtures/files/smart_command/web_plans.json")))
  CSV_TEXT = <<~CSV
    Date,Description,Amount
    2026-11-02,UBER TRIP 8812,-18.40
    2026-11-03,Uber Eats order,-25.10
    2026-11-04,STARBUCKS STORE 1234,-5.25
    2026-11-05,PAYROLL ACME,2000.00
    2026-11-06,VENMO PAYMENT TO SAM,-40.00
    2026-10-12,STARBUCKS STORE 1234,-6.75
    2026-10-15,RENT OCTOBER,-1200.00
    2026-10-20,VENMO PAYMENT TO ALEX,-15.00
  CSV

  setup do
    travel_to Time.zone.local(2026, 11, 11, 12)
    @user = create(:onboarded_user, email: "commands@example.com", usage_region: "US", time_zone: "Central Time (US & Canada)")
    @other = create(:onboarded_user, email: "commands-other@example.com", usage_region: "US", time_zone: "Central Time (US & Canada)")
    import(@user, CSV_TEXT)
    import(@other, "Date,Description,Amount\n2026-11-02,UBER TRIP OTHER,-99.00\n")
    @user.finance_custom_categories.create!(name: "Pets")
    # The importer files Uber trips under Transport; start them unfiled so moving them is a real change.
    [@user, @other].each { |person| person.finance_transactions.where("description ILIKE ?", "%uber%").update_all(category: "Uncategorized") }
    @other.finance_custom_categories.create!(name: "Secret")
  end

  teardown { travel_back }

  # ---------- authentication, scope, malformed input ----------

  test "every endpoint requires a signed-in person" do
    get finance_command_context_path, as: :json
    assert_response :unauthorized
    post finance_command_preview_path, params: {plan: plan(:find_uber)}, as: :json
    assert_response :unauthorized
    post finance_command_execute_path, params: request_for(:find_uber), as: :json
    assert_response :unauthorized
    post finance_command_undo_path, params: {token: "x" * 30}, as: :json
    assert_response :unauthorized
  end

  test "the context has category names and the plan scope, never transactions or amounts" do
    sign_in @user
    get finance_command_context_path, as: :json
    assert_response :success
    body = response.parsed_body
    assert_equal "billieweather-web", body["product"]
    assert_equal Finance::SmartCommand::Executor.tenant_for(@user), body["tenant"]
    assert_equal "2026-11-11", body["today"]
    assert_equal ["Pets"], body["customCategories"]
    assert_includes body["builtInCategories"].find { |c| c["id"] == "Food & dining" }["names"], "食費・外食"
    refute_includes response.body, "UBER"
    refute_includes response.body, "Secret"
    refute_includes response.body, "2000"
    assert_includes response.headers["Cache-Control"], "no-store"
  end

  test "a plan made for another account is refused, and nothing of theirs is counted" do
    sign_in @user
    foreign = plan(:find_uber, tenant: Finance::SmartCommand::Executor.tenant_for(@other))
    post finance_command_preview_path, params: {plan: foreign}, as: :json
    assert_equal "scope_mismatch", response.parsed_body.dig("rejection", "code")
    post finance_command_execute_path, params: {protocol: "nlae/1", plan: foreign, confirmation: {confirmed: false}}, as: :json
    assert_equal "rejected", response.parsed_body["status"]
    assert_equal "scope_mismatch", response.parsed_body["code"]

    execute(:find_uber)
    assert_equal 2, response.parsed_body.dig("data", "count"), "only this person's two Uber rows"
  end

  test "another person's category name is not a valid argument" do
    sign_in @user
    forged = plan(:food_last_month)
    forged["arguments"]["category"] = {"value" => "Secret", "source" => "input"}
    post finance_command_preview_path, params: {plan: forged}, as: :json
    assert_equal "invalid_arguments", response.parsed_body.dig("rejection", "code")
  end

  test "malformed, unready, unknown and oversized requests are refused without running anything" do
    sign_in @user
    post finance_command_preview_path, params: "{not json", headers: {"CONTENT_TYPE" => "application/json", "Accept" => "application/json"}
    assert_response :bad_request
    sign_in @user # the unreadable request never reached the session
    post finance_command_preview_path, params: {plan: "drop table"}, as: :json
    assert_equal "malformed_plan", response.parsed_body.dig("rejection", "code")
    post finance_command_preview_path, params: {plan: plan(:find_uber).merge("protocol" => "nlae/0")}, as: :json
    assert_equal "protocol_mismatch", response.parsed_body.dig("rejection", "code")
    post finance_command_preview_path, params: {plan: plan(:zh_show_last_month_expenses)}, as: :json
    assert_equal "not_ready", response.parsed_body.dig("rejection", "code"), "an ambiguous plan must be answered first"
    post finance_command_preview_path, params: {plan: plan(:find_uber).deep_merge("intent" => {"actionId" => "finance.drop_all"})}, as: :json
    assert_equal "unknown_action", response.parsed_body.dig("rejection", "code")
    post finance_command_preview_path, params: {plan: plan(:find_uber).deep_merge("arguments" => {"sql" => {"value" => "1; DELETE"}})}, as: :json
    assert_equal "invalid_arguments", response.parsed_body.dig("rejection", "code")
    post finance_command_preview_path, params: {plan: plan(:find_uber).deep_merge("arguments" => {"query" => {"value" => "x" * 81}})}, as: :json
    assert_equal "invalid_arguments", response.parsed_body.dig("rejection", "code")
    post finance_command_preview_path, params: {plan: plan(:spent_last_week).deep_merge("arguments" => {"period" => {"value" => {"start" => "2026-02-30", "end" => nil}}})}, as: :json
    assert_equal "invalid_arguments", response.parsed_body.dig("rejection", "code")
    post finance_command_preview_path, params: {plan: plan(:find_uber), padding: "x" * 70_000}, as: :json
    assert_response :content_too_large
  end

  test "an unready plan cannot be forced through execute" do
    sign_in @user
    post finance_command_execute_path, params: request_for(:zh_show_last_month_expenses), as: :json
    assert_equal "not_ready", response.parsed_body["code"]
  end

  # ---------- Phase 1: read-only commands ----------

  test "spending and income totals count exactly what the dashboard counts" do
    sign_in @user
    @user.finance_transactions.find_by!(description: "VENMO PAYMENT TO SAM").update!(excluded: true)
    @user.finance_transactions.find_by!(description: "STARBUCKS STORE 1234", booked_on: Date.new(2026, 11, 4)).update!(category: "Transfers")

    execute(:expenses_this_month)
    assert_equal "succeeded", response.parsed_body["status"]
    snapshot = Finance::Snapshot.new(user: @user, start_date: Date.new(2026, 11, 1), end_date: Date.new(2026, 11, 30)).to_h
    assert_equal snapshot[:expenses].to_s("F"), response.parsed_body.dig("data", "total")
    assert_equal "spending_total", response.parsed_body.dig("summary", "code")
    assert_equal "$43.50", response.parsed_body.dig("summary", "vars", "amount")
    assert_equal 2, response.parsed_body.dig("summary", "vars", "count")

    execute(:income_this_year)
    assert_equal "2000.0", response.parsed_body.dig("data", "total")

    execute(:zh_last_month_expenses)
    assert_equal "$1,221.75", response.parsed_body.dig("summary", "vars", "amount")
  end

  test "last week means the person's calendar week, like the pages" do
    sign_in @user
    execute(:spent_last_week)
    assert_equal({"start" => "2026-11-02", "end" => "2026-11-08"}, plan(:spent_last_week).dig("arguments", "period", "value"))
    assert_equal "$88.75", response.parsed_body.dig("summary", "vars", "amount")
  end

  test "finding transactions counts them and opens the Transactions page with the same filter" do
    sign_in @user
    execute(:find_uber)
    assert_equal 2, response.parsed_body.dig("data", "count")
    redirect = response.parsed_body.dig("data", "redirect")
    assert_equal finance_transactions_path(search: "Uber"), redirect
    get redirect
    assert_response :success
    assert_select ".bw-table tbody tr", count: 2

    execute(:find_coffee_by_category)
    assert_equal 1, response.parsed_body.dig("data", "count")
    assert_equal finance_transactions_path(search: "starbucks", start_date: "2026-10-01", end_date: "2026-10-31"), response.parsed_body.dig("data", "redirect")

    execute(:find_over_amount)
    assert_equal 2, response.parsed_body.dig("data", "count"), "payroll and rent are over $100"
  end

  test "search phrases are matched literally, never as SQL patterns" do
    sign_in @user
    wild = plan(:find_uber)
    wild["arguments"]["query"] = {"value" => "%", "source" => "input"}
    post finance_command_execute_path, params: {protocol: "nlae/1", plan: wild, confirmation: {confirmed: false}, idempotencyKey: wild["planId"]}, as: :json
    assert_equal 0, response.parsed_body.dig("data", "count")
  end

  test "navigation opens only the website's own pages" do
    sign_in @user
    {open_transactions: finance_transactions_path, open_forecast: finance_forecast_path, open_statements: finance_statements_path, zh_open_tax: finance_tax_preparation_path}.each do |key, path|
      execute(key)
      assert_equal path, response.parsed_body.dig("data", "redirect"), key
    end
    elsewhere = plan(:open_transactions)
    elsewhere["arguments"]["page"] = {"value" => "https://evil.example", "source" => "input"}
    post finance_command_execute_path, params: {protocol: "nlae/1", plan: elsewhere, confirmation: {confirmed: false}}, as: :json
    assert_equal "invalid_arguments", response.parsed_body["code"]
  end

  test "balances are the dashboard's, and unknown until there is one" do
    sign_in @user
    execute(:balances)
    assert_equal "balance_unknown", response.parsed_body.dig("summary", "code")
    Finance::Profile.find_or_create_by!(user: @user).update!(current_balance: 1234.5, balance_source: "manual")
    execute(:zh_balance)
    assert_equal "balance_manual", response.parsed_body.dig("summary", "code")
    assert_equal "$1,234.50", response.parsed_body.dig("summary", "vars", "amount")
  end

  test "categories are listed in the interface language, with this person's own" do
    sign_in @user
    execute(:list_categories)
    assert_equal 11, response.parsed_body.dig("data", "count")
    assert_match(/Food & dining.*Pets/, response.parsed_body.dig("summary", "vars", "list"))
    refute_match(/Secret/, response.parsed_body.dig("summary", "vars", "list"))
  end

  test "read-only previews need no confirmation and change nothing" do
    sign_in @user
    before = @user.finance_transactions.order(:id).pluck(:id, :category, :excluded, :updated_at)
    post finance_command_preview_path, params: {plan: plan(:expenses_this_month)}, as: :json
    assert response.parsed_body["ok"]
    assert_equal "none", response.parsed_body.dig("plan", "confirmation")
    assert_match(/\A\h{32}\z/, response.parsed_body.dig("plan", "fingerprint"))
    assert_equal before, @user.finance_transactions.order(:id).pluck(:id, :category, :excluded, :updated_at)
  end

  test "the layout mounts the command bar only on signed-in finance pages" do
    get root_path
    assert_select "[data-smart-command]", count: 0
    assert_select "script[src='/billie-command.js']", count: 0
    sign_in @user
    get finance_dashboard_path
    assert_select ".bw-topbar [data-smart-command][data-context-url='#{finance_command_context_path}'][data-locale='en']"
    assert_select "script[src='/billie-command.js'][defer]"
    assert_select "link[href='/billie-command.css']"
    assert File.exist?(Rails.root.join("public/billie-command.js"))
  end

  test "the manifest the executor trusts is the generated web registry, and only reads skip confirmation" do
    manifest = Finance::SmartCommand::Manifest.current
    assert_equal "billieweather-web", manifest.product
    handled = Finance::SmartCommand::ReadHandlers::ACTIONS + Finance::SmartCommand::WriteHandlers::ACTIONS
    assert_equal handled.sort, manifest.action_ids.sort, "every web command has a trusted handler, and nothing else is accepted"
    assert Finance::SmartCommand::ReadHandlers::ACTIONS.all? { |id| manifest.confirmation_for(manifest.action(id)) == "none" }
    assert Finance::SmartCommand::WriteHandlers::ACTIONS.all? { |id| manifest.confirmation_for(manifest.action(id)) == "confirm" }
  end

  # ---------- Phase 2: controlled writes ----------

  test "a change needs a preview and an explicit confirmation, whatever the browser claims" do
    sign_in @user
    forged = plan(:categorize_uber).merge("risk" => "none", "confirmation" => "none")
    post finance_command_execute_path, params: {protocol: "nlae/1", plan: forged, confirmation: {confirmed: false}, idempotencyKey: forged["planId"]}, as: :json
    assert_equal "confirmation_required", response.parsed_body["code"]
    post finance_command_execute_path, params: {protocol: "nlae/1", plan: forged, confirmation: {confirmed: true}, idempotencyKey: forged["planId"]}, as: :json
    assert_equal "stale_preview", response.parsed_body["code"], "never previewed: no server fingerprint"
    forged["fingerprint"] = "0" * 32
    post finance_command_execute_path, params: {protocol: "nlae/1", plan: forged, confirmation: {confirmed: true}, idempotencyKey: forged["planId"]}, as: :json
    assert_equal "stale_preview", response.parsed_body["code"], "a made-up fingerprint is not a preview"
    assert_equal %w[Uncategorized Uncategorized], uber_rows.map(&:category)
    assert_empty Finance::CommandExecution.all
  end

  test "deleting categories and unknown actions are not available from the website's bar" do
    sign_in @user
    forged = plan(:rename_category).deep_merge("intent" => {"actionId" => "categories.delete"})
    forged["arguments"] = {"target" => {"value" => "Pets", "source" => "input"}}
    post finance_command_preview_path, params: {plan: forged}, as: :json
    assert_equal "unknown_action", response.parsed_body.dig("rejection", "code")
    assert @user.finance_custom_categories.exists?(name: "Pets")
  end

  test "the preview lists exactly the rows the change then makes, and only this person's" do
    sign_in @user
    preview = preview!(:categorize_uber)
    assert_equal "confirm", preview["confirmation"]
    assert_equal uber_rows.map { |row| row.id.to_s }, preview["operations"].map { |op| op.dig("target", "id") }
    assert_equal [{"category" => "Transport"}] * 2, preview["operations"].map { |op| op["after"] }
    other_uber = @other.finance_transactions.sole

    confirm!(preview)
    body = response.parsed_body
    assert_equal "succeeded", body["status"]
    assert_equal "categorized", body.dig("summary", "code")
    assert_equal 2, body.dig("summary", "vars", "count")
    assert_equal %w[Transport Transport], uber_rows.map(&:category)
    assert_equal "Uncategorized", other_uber.reload.category, "another person's matching row is never touched"
    assert_equal preview["operations"].map { |op| op.dig("target", "id") }, body["operations"].map { |op| op.dig("target", "id") }
    assert_empty @user.finance_merchant_rules, "a command changes only what its preview showed"
  end

  test "a preview made stale by another change is refused and nothing changes" do
    sign_in @user
    preview = preview!(:categorize_uber)
    uber_rows.first.update!(category: "Shopping")
    confirm!(preview)
    assert_equal "stale_preview", response.parsed_body["code"]
    assert_equal %w[Shopping Uncategorized], uber_rows.map(&:category)

    # A new matching row also makes it stale.
    preview = preview!(:exclude_venmo)
    import(@user, "Date,Description,Amount\n2026-11-09,VENMO PAYMENT TO KIM,-7.00\n")
    confirm!(preview)
    assert_equal "stale_preview", response.parsed_body["code"]
    assert_equal [false, false, false], venmo_rows.map(&:excluded)

    confirm!(preview!(:exclude_venmo))
    assert_equal "succeeded", response.parsed_body["status"]
    assert_equal [true, true, true], venmo_rows.map(&:excluded)
  end

  test "repeated submissions run a change once and replay the first result" do
    sign_in @user
    preview = preview!(:categorize_uber)
    request = {protocol: "nlae/1", plan: preview, confirmation: {confirmed: true}, idempotencyKey: preview["planId"]}
    post finance_command_execute_path, params: request, as: :json
    first = response.parsed_body
    assert_equal false, first["replayed"]
    uber_rows.first.update_columns(category: "Health") # changed after the command ran

    post finance_command_execute_path, params: request, as: :json
    second = response.parsed_body
    assert_equal "succeeded", second["status"]
    assert_equal true, second["replayed"]
    assert_equal first["summary"], second["summary"]
    assert_equal first.dig("undo", "token"), second.dig("undo", "token")
    assert_equal %w[Health Transport], uber_rows.map(&:category), "not applied a second time"
    assert_equal 1, @user.finance_command_executions.count

    reused = plan(:exclude_venmo)
    post finance_command_execute_path, params: {protocol: "nlae/1", plan: preview!(:exclude_venmo), confirmation: {confirmed: true}, idempotencyKey: preview["planId"]}, as: :json
    assert_equal "idempotency_conflict", response.parsed_body["code"]
    assert reused
    assert_equal [false, false], venmo_rows.map(&:excluded)
  end

  test "a failure part-way rolls every row back and keeps no record" do
    sign_in @user
    preview = preview!(:categorize_uber)
    stub_method(Finance::Profile, :where, ->(*) { raise ActiveRecord::StatementInvalid, "boom" }) do
      confirm!(preview)
    end
    assert_equal "failed", response.parsed_body["status"]
    assert_equal "handler_error", response.parsed_body["code"]
    assert_equal %w[Uncategorized Uncategorized], uber_rows.map(&:category)
    assert_empty Finance::CommandExecution.all
    # Nothing was stored for that key, so the same command can be retried.
    confirm!(preview)
    assert_equal "succeeded", response.parsed_body["status"]
  end

  test "undo restores the previous state once, and only within its time" do
    sign_in @user
    confirm!(preview!(:categorize_uber))
    token = response.parsed_body.dig("undo", "token")
    assert_match(/\A\h{64}\z/, token)
    record = @user.finance_command_executions.sole
    refute_equal token, record.undo_token_digest, "only a digest of the token is stored"
    refute_includes record.undo_payload.to_json, "UBER", "undo data holds ids and previous values, not descriptions"

    post finance_command_undo_path, params: {protocol: "nlae/1", token: token}, as: :json
    assert_equal "succeeded", response.parsed_body["status"]
    assert_equal %w[Uncategorized Uncategorized], uber_rows.map(&:category)
    assert_nil record.reload.undo_payload
    post finance_command_undo_path, params: {protocol: "nlae/1", token: token}, as: :json
    assert_equal "undo_unavailable", response.parsed_body["code"]

    confirm!(preview!(:exclude_venmo))
    late = response.parsed_body.dig("undo", "token")
    travel 11.minutes
    post finance_command_undo_path, params: {protocol: "nlae/1", token: late}, as: :json
    assert_equal "undo_expired", response.parsed_body["code"]
    assert_equal [true, true], venmo_rows.map(&:excluded)
  end

  test "undo refuses when anything it would restore changed since, and changes nothing" do
    sign_in @user
    confirm!(preview!(:categorize_uber))
    token = response.parsed_body.dig("undo", "token")
    uber_rows.last.update!(category: "Shopping")
    post finance_command_undo_path, params: {protocol: "nlae/1", token: token}, as: :json
    assert_equal "undo_conflict", response.parsed_body["code"]
    assert_equal %w[Transport Shopping], uber_rows.map(&:category), "not even the unchanged row was restored"
  end

  test "another person cannot use an undo token" do
    sign_in @user
    confirm!(preview!(:exclude_venmo))
    token = response.parsed_body.dig("undo", "token")
    sign_in @other
    post finance_command_undo_path, params: {protocol: "nlae/1", token: token}, as: :json
    assert_equal "undo_unavailable", response.parsed_body["code"]
    assert_equal [true, true], venmo_rows.map(&:excluded)
  end

  test "excluding and including change the totals exactly as the dashboard counts them" do
    sign_in @user
    execute(:zh_last_month_expenses)
    assert_equal "$1,221.75", response.parsed_body.dig("summary", "vars", "amount")
    confirm!(preview!(:exclude_venmo))
    execute(:zh_last_month_expenses)
    assert_equal "$1,206.75", response.parsed_body.dig("summary", "vars", "amount")
    expected = Finance::Snapshot.new(user: @user, start_date: Date.new(2026, 10, 1), end_date: Date.new(2026, 10, 31)).to_h[:expenses]
    assert_equal expected.to_s("F"), response.parsed_body.dig("data", "total")
    confirm!(preview!(:include_venmo))
    assert_equal [false, false], venmo_rows.map(&:excluded)
  end

  test "categories are created and renamed under the website's own rules, and undone safely" do
    sign_in @user
    confirm!(preview!(:create_category))
    assert_equal "category_created", response.parsed_body.dig("summary", "code")
    created_undo = response.parsed_body.dig("undo", "token")
    assert @user.finance_custom_categories.exists?(name: "Pet care")

    post finance_command_preview_path, params: {plan: plan(:create_category)}, as: :json
    assert_equal "no_effect", response.parsed_body.dig("rejection", "code")
    assert_equal "category_exists", response.parsed_body.dig("rejection", "summary", "code")
    built_in = plan(:create_category)
    built_in["arguments"]["name"] = {"value" => "shopping", "source" => "input"}
    post finance_command_preview_path, params: {plan: built_in}, as: :json
    assert_equal "category_reserved", response.parsed_body.dig("rejection", "summary", "code")

    # Undo of a create is refused once the category is in use.
    uber_rows.first.update!(category: "Pet care")
    post finance_command_undo_path, params: {protocol: "nlae/1", token: created_undo}, as: :json
    assert_equal "undo_conflict", response.parsed_body["code"]
    assert @user.finance_custom_categories.exists?(name: "Pet care")

    uber_rows.first.update!(category: "Pets")
    confirm!(preview!(:rename_category))
    assert_equal "category_renamed", response.parsed_body.dig("summary", "code")
    assert_equal "Animals", uber_rows.first.category, "transactions follow the rename (CustomCategory#rename!)"
    post finance_command_undo_path, params: {protocol: "nlae/1", token: response.parsed_body.dig("undo", "token")}, as: :json
    assert_equal "succeeded", response.parsed_body["status"]
    assert_equal "Pets", uber_rows.first.category
    assert @user.finance_custom_categories.exists?(name: "Pets")
  end

  test "deleting financial data also removes command history" do
    sign_in @user
    confirm!(preview!(:exclude_venmo))
    assert_equal 1, @user.finance_command_executions.count
    Finance::DataDeletion.call(user: @user)
    assert_equal 0, Finance::CommandExecution.where(user_id: @user.id).count
  end

  private

  def plan(key, tenant: Finance::SmartCommand::Executor.tenant_for(@user))
    copy = PLANS.fetch(key.to_s).deep_dup
    copy["scope"]["tenant"] = tenant
    copy["planId"] = "#{key.to_s.tr("_", "-")}-#{SecureRandom.hex(6)}"
    copy
  end

  def request_for(key, confirmed: false)
    planned = plan(key)
    {protocol: "nlae/1", plan: planned, confirmation: {confirmed: confirmed}, idempotencyKey: planned["planId"]}
  end

  def execute(key)
    post finance_command_execute_path, params: request_for(key), as: :json
    assert_response :success
  end

  def preview!(key)
    post finance_command_preview_path, params: {plan: plan(key)}, as: :json
    assert_response :success
    assert response.parsed_body["ok"], response.parsed_body.inspect
    response.parsed_body["plan"]
  end

  def confirm!(previewed)
    post finance_command_execute_path, params: {protocol: "nlae/1", plan: previewed, confirmation: {confirmed: true}, idempotencyKey: previewed["planId"]}, as: :json
    assert_response :success
  end

  def uber_rows
    @user.finance_transactions.where("description ILIKE ?", "%uber%").order(:id).to_a
  end

  def venmo_rows
    @user.finance_transactions.where("description ILIKE ?", "%venmo%").order(:id).to_a
  end

  def import(user, text)
    Tempfile.create(["commands", ".csv"]) do |file|
      file.write(text)
      file.rewind
      Finance::StatementImporter.new(user: user, file: Rack::Test::UploadedFile.new(file.path, "text/csv", original_filename: "commands.csv"), currency: "USD").call
    end
  end
end
