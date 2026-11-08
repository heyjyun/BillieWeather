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
    assert_select ".bw-language-switcher a[aria-current='true']", text: "中文"

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
        if item.is_a?(Hash)
          result.merge!(flatten.call(item, path))
        else
          result[path.join(".")] = item
        end
      end
    end
    catalogs.each do |english_path|
      chinese_path = english_path.sub(/\.en\.yml\z/, ".zh-CN.yml")
      assert File.exist?(chinese_path), "Missing #{chinese_path}"
      english = flatten.call(YAML.safe_load_file(english_path).fetch("en").fetch("billie", {}))
      chinese = flatten.call(YAML.safe_load_file(chinese_path).fetch("zh-CN").fetch("billie", {}))
      # The Chinese helper catalog also contains Chinese-only count labels.
      english.each do |key, value|
        assert chinese.key?(key), "Missing Chinese key #{key} in #{chinese_path}"
        next unless value.is_a?(String)
        assert_equal value.scan(/%\{(\w+)\}/).sort, chinese[key].scan(/%\{(\w+)\}/).sort,
          "Interpolation mismatch for #{key}"
      end
    end
  end
end
