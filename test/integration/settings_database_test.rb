require "test_helper"

# Settings › Your database: what the cloud database holds, and deleting one statement at a
# time, placed right above the "delete my financial data / delete my account" buttons.
class SettingsDatabaseTest < ActionDispatch::IntegrationTest
  include Devise::Test::IntegrationHelpers

  setup do
    @user = create(:onboarded_user, usage_region: "US")
    @statement = seed(@user, "4", filename: "march-checking.csv")
    @other = create(:onboarded_user)
    @other_statement = seed(@other, "5", filename: "someone-else.csv")
  end

  def seed(user, digit, filename:)
    Finance::Profile.find_or_create_by!(user: user) { |profile| profile.currency = "USD" }
    account = Finance::BankAccount.create!(user: user, identity_key: digit * 64, bank_name: "Chase", name: "Checking", last4: "1234", kind: "cash")
    statement = Finance::Statement.create!(user: user, bank_account: account, filename: filename, currency: "USD", sha256: digit * 64, transaction_count: 2)
    Finance::MerchantRule.create!(user: user, merchant_key: "coffee bar #{digit}", category: "Food & dining")
    Finance::Transaction.create!(user: user, statement: statement, booked_on: Date.new(2026, 3, 1), description: "Payroll", amount: "100.00", category: "Income")
    Finance::Transaction.create!(user: user, statement: statement, booked_on: Date.new(2026, 3, 9), description: "Coffee bar", amount: "-4.00", category: "Food & dining")
    statement
  end

  def fact(label)
    css_select("#settings-database .bw-db-facts > div").find { |row| row.at_css("dt").text == label }&.at_css("dd")&.text
  end

  test "the database section sits directly above Privacy & data and shows only this person's data" do
    sign_in @user
    get finance_settings_path, params: {locale: "en"}
    assert_response :success
    ids = css_select("main section.bw-panel").map { |section| section["id"] }
    assert_equal %w[settings-database settings-privacy], ids.last(2)

    assert_equal "1", fact("Statements")
    assert_equal "2", fact("Transactions")
    assert_equal "1", fact("Bank accounts")
    assert_equal "1", fact("Remembered rules")
    assert_match(/\Aabout \d+(\.\d)? (B|KB|MB)\z/, fact("Size"))
    assert_match(/Mar 1, 2026 – Mar 9, 2026/, fact("Dates"))

    assert_select "#settings-database details summary", text: "Show statements (1)"
    assert_select "#settings-database li", text: /march-checking\.csv/
    assert_no_match(/someone-else\.csv/, response.body)
    assert_select "#settings-database form[action='#{finance_statement_path(@statement)}'][data-confirm]" do
      assert_select "input[name='_method'][value=delete]"
      assert_select "input[name='return_to'][value=settings]"
    end
    assert_select "#settings-database a[href='#{billie_download_path}']"
    assert_select "#settings-database a[href='#{finance_statements_path}']"
    # The two "delete everything" buttons are unchanged.
    assert_select "#settings-privacy > .bw-privacy-buttons button[data-dialog-open]", count: 2
  end

  test "deleting a statement from settings removes it from the cloud and returns to the section" do
    sign_in @user
    assert_difference -> { Finance::Transaction.where(user_id: @user.id).count }, -2 do
      delete finance_statement_path(@statement), params: {return_to: "settings"}
    end
    assert_redirected_to finance_settings_path(anchor: "settings-database")
    follow_redirect!
    assert_equal "0", fact("Statements")
    assert_select "#settings-database .bw-db-empty"
    assert Finance::Statement.exists?(@other_statement.id), "other people's data is untouched"
  end

  test "statements page deletion still returns to the statements page, and nobody can delete someone else's statement" do
    sign_in @user
    delete finance_statement_path(@statement)
    assert_redirected_to finance_statements_path
    delete finance_statement_path(@other_statement), params: {return_to: "settings"}
    assert_response :not_found
    assert Finance::Statement.exists?(@other_statement.id)
  end

  test "the section is translated in every language" do
    sign_in @user
    %w[en es ja ko zh-CN zh-TW].each do |locale|
      get finance_settings_path, params: {locale: locale}
      assert_response :success
      assert_no_match(/translation_missing|Translation missing/, response.body, locale)
      assert_select "#settings-database h2", text: I18n.t("billie.database.default_name", locale: locale)
    end
  end

  test "the cloud database can be named on the website, and the name is the section's title" do
    sign_in @user
    get finance_settings_path, params: {locale: "en"}
    assert_select "#settings-database-heading", text: "BillieWeather cloud"
    patch database_name_finance_settings_path, params: {user: {cloud_database_name: "  Family   books "}}
    assert_redirected_to finance_settings_path(anchor: "settings-database")
    assert_equal "Family books", @user.reload.cloud_database_name
    get finance_settings_path, params: {locale: "en"}
    assert_select "#settings-database-heading", text: "Family books"

    patch database_name_finance_settings_path, params: {user: {cloud_database_name: "x" * 61}}
    assert_response :unprocessable_entity
    assert_equal "Family books", @user.reload.cloud_database_name
  end

  # ---- local databases reported by the apps (display only)
  DEVICE_ID = "3f2b1c9e-7a4d-4e8b-9c11-0a1b2c3d4e5f"

  def report_local(user, name: "Personal Finance 2026", database_id: SecureRandom.uuid, size: 19_293_798, reported_at: Time.current, device_name: "Jyun's MacBook")
    Finance::LocalDevice.find_or_create_by!(user: user, device_id: DEVICE_ID) { |device| device.name = device_name }
    Finance::LocalDatabaseReport.create!(user: user, device_id: DEVICE_ID, database_id: database_id, name: name, size_bytes: size, statement_count: 24,
      transaction_count: 1240, rule_count: 36, period_start: Date.new(2026, 1, 2), period_end: Date.new(2026, 10, 30),
      modified_at: Time.utc(2026, 11, 9, 22, 0), opened_at: Time.utc(2026, 11, 9, 22, 25), sequence: 1, reported_at: reported_at)
  end

  test "local databases appear as read-only cards, clearly separate from the cloud database" do
    report_local(@user)
    report_local(@other, name: "Someone else's")
    sign_in @user
    get finance_settings_path, params: {locale: "en"}
    assert_response :success
    card = css_select("#settings-local-databases [data-local-database]").sole
    assert_equal "Personal Finance 2026", card.at_css("h4").text
    assert_includes card.text, "Local Database"
    assert_includes card.text, "Jyun's MacBook"
    assert_includes card.text, "18.4 MB"
    assert_includes card.text, "1,240"
    assert_includes card.text, "This database is stored on your device. You can only open or modify it from that device."
    assert_empty card.css("form, button, a, input, select"), "no delete, rename, edit, open or sync controls"
    assert_not_includes response.body, "Someone else&#39;s"
    assert_no_match(/Not updated for over 30 days/, card.text)
    # Three different things, never merged: a metadata report is not a sync and not a backup.
    labels = card.css("dt").map(&:text)
    assert_includes labels, "Metadata Last Updated"
    assert_includes labels, "Last Synced"
    assert_includes labels, "Last Backed Up"
    assert_not_includes labels, "Last reported"
    assert_equal "No backups yet", card.css("div").find { |row| row.at_css("dt")&.text == "Last Backed Up" }.at_css("dd").text
    assert_includes card.text, "It is not a sync and not a backup."
  end

  test "storage keeps cloud and local separate and never counts local bytes as cloud storage" do
    report_local(@user, size: 10 * 1024 * 1024)
    sign_in @user
    get finance_settings_path, params: {locale: "en"}
    cloud_bytes = Finance::DatabaseOverview.new(@user).storage_bytes
    totals = css_select("[data-usage-totals]").sole.text.squish
    assert_includes totals, "Cloud storage on BillieWeather's servers: #{helper_size(cloud_bytes)}."
    assert_includes totals, "Local storage reported by your devices: 10 MB."
    assert_includes totals, "not uploaded and do not count as cloud storage"
    assert_equal 1, css_select("[data-usage^='local-']").size
    assert_equal "10 MB", css_select("[data-usage^='local-'] small").last.text
    assert_equal helper_size(cloud_bytes), fact("Size").sub("about ", "")
    # Local rows never change the cloud fact above.
  end

  def helper_size(bytes) = ApplicationController.helpers.database_size(bytes)

  test "reports older than 30 days are marked as possibly outdated, with the server's timestamp" do
    report_local(@user, name: "Old one", reported_at: 31.days.ago)
    report_local(@user, name: "Fresh one", reported_at: 29.days.ago)
    sign_in @user
    get finance_settings_path, params: {locale: "en"}
    old, fresh = css_select("[data-local-database]").partition { |card| card.at_css("h4").text == "Old one" }.map(&:first)
    assert_includes old.text, "Not updated for over 30 days. Information may be outdated."
    assert_no_match(/Not updated for over 30 days/, fresh.text)
    assert_includes old.text, "Metadata Last Updated"
  end

  test "times are shown in the person's own time zone, with the zone named" do
    @user.update!(time_zone: "Pacific Time (US & Canada)")
    report_local(@user, reported_at: Time.utc(2026, 11, 9, 22, 30))
    sign_in @user
    get finance_settings_path, params: {locale: "en"}
    text = css_select("[data-local-database]").sole.text
    assert_includes text, "November 9, 2026, 2:30 PM PST"
    assert_includes text, "November 9, 2026, 2:00 PM PST" # last modified on device
    assert_includes text, "November 9, 2026, 2:25 PM PST" # app opened
  end

  test "database and device names are shown as plain text, never as HTML" do
    report_local(@user, name: "<script>alert(1)</script>", device_name: "<img src=x onerror=alert(2)>")
    sign_in @user
    get finance_settings_path, params: {locale: "en"}
    assert_not_includes response.body, "<script>alert(1)</script>"
    assert_not_includes response.body, "<img src=x"
    assert_includes response.body, "&lt;script&gt;alert(1)&lt;/script&gt;"
  end

  test "with nothing reported the section says local databases appear once the app is opened" do
    sign_in @user
    get finance_settings_path, params: {locale: "en"}
    assert_includes css_select("#settings-local-databases").text, "They appear here after you open the BillieWeather app while signed in."
    assert_no_match(/Show My Local Databases|Turn on/, css_select("#settings-local-databases").text)
    assert_empty css_select("[data-local-database]")
  end

  test "deleted (tombstoned) local databases do not appear" do
    report = report_local(@user)
    report.update!(deleted_at: Time.current, name: nil, size_bytes: nil)
    sign_in @user
    get finance_settings_path, params: {locale: "en"}
    assert_empty css_select("[data-local-database]")
  end

  test "local database cards are translated in every language" do
    report_local(@user)
    sign_in @user
    %w[en es ja ko zh-CN zh-TW].each do |locale|
      get finance_settings_path, params: {locale: locale}
      assert_response :success
      assert_no_match(/translation_missing|Translation missing/, response.body, locale)
      card = css_select("[data-local-database]").sole
      assert_includes card.text, I18n.t("billie.database.local.status_local", locale: locale), locale
      assert_includes card.text, I18n.t("billie.database.local.reported", locale: locale), locale
    end
    get finance_settings_path, params: {locale: "zh-CN"}
    card = css_select("[data-local-database]").sole.text
    %w[本地数据库 元数据最近更新 最近同步 最近备份 还没有备份].each { |text| assert_includes card, text }
    assert_no_match(/Metadata Last Updated|Last Synced|Local Database|No backups yet/, card)
  end
end
