require "test_helper"

class BillieLocalizationTest < ActionDispatch::IntegrationTest
  include Devise::Test::IntegrationHelpers

  test "browser language selects Simplified Chinese and explicit choice survives navigation" do
    get root_path, headers: {"HTTP_ACCEPT_LANGUAGE" => "zh-CN,zh;q=0.9,en;q=0.8"}
    assert_response :success
    assert_select "html[lang='zh-CN']"
    assert_select "a", text: "开始使用"

    get root_path, params: {locale: "en"}, headers: {"HTTP_ACCEPT_LANGUAGE" => "zh-CN"}
    assert_select "html[lang='en']"
    get new_user_session_path, headers: {"HTTP_ACCEPT_LANGUAGE" => "zh-CN"}
    assert_select "html[lang='en']"
    assert_select "h1", text: "Your financial outlook awaits."

    get new_user_registration_path, params: {locale: "zh-CN"}
    assert_select "html[lang='zh-CN']"
    assert_select "label", text: "电子邮箱"
    get new_user_session_path
    assert_select "html[lang='zh-CN']"
  end

  test "unsupported and malformed locale values are ignored and request locale is restored" do
    original_locale = I18n.locale
    get root_path, params: {locale: "not-a-language"}
    assert_response :success
    assert_select "html[lang='en']"
    get root_path, params: {locale: ["zh-CN"]}
    assert_response :success
    assert_select "html[lang='en']"
    get root_path, params: {locale: "zh-CN"}
    assert_select "html[lang='zh-CN']"
    assert_equal original_locale, I18n.locale

    other_browser = open_session
    other_browser.get root_path
    other_browser.assert_select "html[lang='en']"
  end

  test "Chinese finance pages retain canonical categories and language selection preserves filters" do
    user = create(:user)
    statement = Finance::Statement.create!(user: user, filename: "locale.csv", currency: "USD", sha256: "8" * 64, transaction_count: 1)
    transaction = Finance::Transaction.create!(user: user, statement: statement, booked_on: Date.current,
      description: "Original merchant 商户", amount: "-25.50", category: "Food & dining")
    sign_in user

    get finance_dashboard_path, params: {locale: "zh-CN"}
    assert_response :success
    assert_select "html[lang='zh-CN']"
    assert_includes response.body, "餐饮"
    assert_includes response.body, "Original merchant 商户"
    assert_includes response.body, Date.current.strftime("%Y年%-m月%-d日")
    assert_select ".bw-language-switcher a[aria-current='true']", text: "简体中文"

    get finance_transactions_path, params: {category: "Food & dining", search: "Original merchant"}
    assert_response :success
    assert_select "option[value='Food & dining'][selected]", text: "餐饮"
    assert_select ".bw-language-switcher a[lang='en']" do |links|
      query = Rack::Utils.parse_nested_query(URI.parse(links.first["href"]).query)
      assert_equal "en", query["locale"]
      assert_equal "Food & dining", query["category"]
      assert_equal "Original merchant", query["search"]
    end

    [finance_statements_path, finance_forecast_path(engine: "linear"), finance_insights_path, edit_finance_transaction_path(transaction)].each do |path|
      get path
      assert_response :success
      assert_select "html[lang='zh-CN']"
      assert_no_match(/translation_missing|Translation missing/, response.body)
    end
    assert_equal "Food & dining", transaction.reload.category
    assert_equal BigDecimal("-25.50"), transaction.amount

    delete destroy_user_session_path
    get new_user_session_path
    assert_response :success
    assert_select "html[lang='zh-CN']"
  end

  test "Chinese validation and forecast errors are localized" do
    user = create(:user)
    sign_in user
    get finance_forecast_path, params: {locale: "zh-CN", engine: "invalid"}
    assert_response :unprocessable_entity
    assert_select "[role='alert']", text: /[\p{Han}]/
    I18n.with_locale(:"zh-CN") do
      profile = Finance::Profile.new(user: user, current_balance: "1.234")
      assert_not profile.valid?
      assert_includes profile.errors.full_messages.join, "最多保留两位小数"
    end
  end

  test "application translation catalogs have matching keys and interpolation variables" do
    catalogs = Dir[Rails.root.join("config/locales/billie*.en.yml")]
    assert catalogs.any?
    flatten = lambda do |value, prefix = []|
      value.each_with_object({}) do |(key, item), result|
        path = prefix + [key.to_s]
        if item.is_a?(Hash) && item.key?("other") && (item.keys - %w[zero one two few many other]).empty?
          result[path.join(".")] = item.values
        elsif item.is_a?(Hash)
          result.merge!(flatten.call(item, path))
        else
          result[path.join(".")] = [item]
        end
      end
    end
    catalogs.each do |english_path|
      english = flatten.call(YAML.safe_load_file(english_path).fetch("en"))
      %w[zh-CN zh-TW ja ko es].each do |locale|
        translated_path = english_path.sub(/\.en\.yml\z/, ".#{locale}.yml")
        assert File.exist?(translated_path), "Missing #{translated_path}"
        translated = flatten.call(YAML.safe_load_file(translated_path).fetch(locale))
        english.each do |key, values|
          assert translated.key?(key), "Missing #{locale} key #{key} in #{translated_path}"
          variables = values.first.scan(/%\{(\w+)\}/).sort
          translated.fetch(key).each do |value|
            assert_equal variables, value.scan(/%\{(\w+)\}/).sort,
              "Interpolation mismatch for #{locale}.#{key}"
          end
        end
      end
    end
  end

  test "browser detects Traditional Chinese regions and scripts without selecting Simplified Chinese" do
    {"zh-TW" => "zh-TW", "zh-HK,en;q=0.8" => "zh-TW", "zh-Hant" => "zh-TW",
     "zh-Hant-TW" => "zh-TW", "zh-Hans" => "zh-CN", "zh-CN" => "zh-CN"}.each do |language, expected|
      browser = open_session
      browser.get root_path, headers: {"HTTP_ACCEPT_LANGUAGE" => language}
      browser.assert_response :success
      browser.assert_select "html[lang='#{expected}']"
    end
  end

  %w[zh-TW ja ko es].each do |locale|
    test "#{locale} browser detection authentication and language menu work" do
      language = {"zh-TW" => "zh-TW", "ja" => "ja-JP", "ko" => "ko-KR", "es" => "es-MX"}.fetch(locale)
      get root_path, headers: {"HTTP_ACCEPT_LANGUAGE" => "#{language},en;q=0.8"}
      assert_response :success
      assert_select "html[lang='#{locale}']"
      label = {"zh-TW" => "繁體中文", "ja" => "日本語", "ko" => "한국어", "es" => "Español"}.fetch(locale)
      assert_select "details.bw-language-menu > summary", text: /#{label}/
      assert_select ".bw-language-switcher a", count: 6
      %w[en zh-CN zh-TW ja ko es].each { |option| assert_select ".bw-language-switcher a[lang='#{option}']" }

      get new_user_session_path, params: {locale: locale}
      assert_select "html[lang='#{locale}']"
      assert_select "label", text: I18n.t("billie.auth.email", locale: locale)
      post user_session_path, params: {user: {email: "missing@example.com", password: "invalid-password"}}
      assert_response :unprocessable_entity
      assert_select "html[lang='#{locale}']"
      assert_select "[role='alert']", text: I18n.t("devise.failure.invalid", locale: locale,
        authentication_keys: I18n.t("activerecord.attributes.user.email", locale: locale))
      assert_select ".bw-language-switcher a[lang='en'][href='#{new_user_session_path(locale: 'en')}']"
    end

    test "#{locale} finance pages reports and validation use localized text with canonical data" do
      user = create(:user)
      statement = Finance::Statement.create!(user: user, filename: "multilingual.csv", currency: "USD", sha256: "7" * 64, transaction_count: 1)
      transaction = Finance::Transaction.create!(user: user, statement: statement, booked_on: Date.current,
        description: "Original merchant 商户 お店 가게", amount: "-25.50", category: "Food & dining")
      account = Finance::BankAccount.create!(user: user, identity_key: "9" * 64, bank_name: "Chase", name: "Checking", last4: "1234", kind: "cash")
      statement.update!(bank_account: account, closing_balance: "800.00", closing_balance_on: Date.current)
      sign_in user
      get finance_dashboard_path, params: {locale: locale}
      assert_response :success
      assert_select "html[lang='#{locale}']"
      assert_includes response.body, I18n.t("billie.helpers.labels.food", locale: locale)
      assert_includes response.body, I18n.l(Date.current, locale: locale, format: I18n.t("billie.helpers.date_format", locale: locale))
      assert_includes response.body, I18n.t("billie.helpers.labels.checking", locale: locale)

      [finance_statements_path, finance_transactions_path, finance_forecast_path(engine: "linear"), finance_insights_path,
       edit_finance_transaction_path(transaction)].each do |path|
        get path
        assert_response :success
        assert_select "html[lang='#{locale}']"
        assert_no_match(/translation_missing|Translation missing/, response.body)
      end
      get finance_forecast_path, params: {engine: "invalid"}
      assert_response :unprocessable_entity
      assert_select "[role='alert']", text: I18n.t("billie.backend.choose_forecast_model", locale: locale)

      post generate_finance_insights_path, params: {provider: "rules"}
      assert_redirected_to finance_insights_path
      content = user.finance_insights.last.content
      assert_includes content.fetch("observations").map { |item| item["body"] }.join, I18n.t("billie.helpers.labels.food", locale: locale)
      assert_not_includes content.fetch("summary"), "Your imported activity"
      I18n.with_locale(locale) do
        profile = Finance::Profile.new(user: user, current_balance: "1.234")
        assert_not profile.valid?
        assert_includes profile.errors.full_messages.join, I18n.t("errors.messages.cent_precision")
      end
      assert_equal "Checking", account.reload.name
      assert_equal "Food & dining", transaction.reload.category
      assert_equal "Original merchant 商户 お店 가게", transaction.description
      assert_equal BigDecimal("-25.50"), transaction.amount

      delete destroy_user_session_path
      get new_user_session_path
      assert_select "html[lang='#{locale}']"
    end
  end
end
