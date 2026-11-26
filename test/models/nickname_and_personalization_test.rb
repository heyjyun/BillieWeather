require "test_helper"

# The required nickname (User) and the localized, nickname-aware messages (Personalization).
class NicknameAndPersonalizationTest < ActiveSupport::TestCase
  def new_user(**attributes)
    User.new({email: "nick-#{SecureRandom.hex(4)}@example.com", password: "Gr33nCloud!Rain&2026",
              password_confirmation: "Gr33nCloud!Rain&2026", usage_region: "US"}.merge(attributes))
  end

  def nickname_errors(user)
    user.validate
    user.errors.details[:nickname].map { |detail| detail[:error].to_s }
  end

  test "new accounts must choose a nickname; blank, whitespace-only and invisible-only input is refused" do
    [nil, "", "   ", "\t\n", "　　", "​‍"].each do |blank|
      assert_equal ["blank"], nickname_errors(new_user(nickname: blank)), blank.inspect
    end
  end

  test "nicknames are trimmed, may use any script, are limited to 40 characters and need not be unique" do
    ["小雨", "陳美玲", "ジュン", "김윤", "José María", "O'Brien-Smith", "Ana 🌤", "n" * 40].each do |name|
      user = new_user(nickname: "  #{name}  ")
      assert user.valid?, "#{name}: #{user.errors.full_messages.to_sentence}"
      assert_equal name, user.nickname
    end
    assert_equal "Sunny Day", new_user(nickname: " Sunny 　  Day ").tap(&:validate).nickname
    assert_equal ["too_long"], nickname_errors(new_user(nickname: "n" * 41))
    assert_equal ["invalid"], nickname_errors(new_user(nickname: "Bil\u0007lie"))
    create(:onboarded_user, nickname: "Sunny")
    assert new_user(nickname: "Sunny").valid?
  end

  test "existing accounts without a nickname keep working until they choose one, and then cannot clear it" do
    user = create(:onboarded_user)
    user.update_column(:nickname, nil)
    user.reload
    assert user.needs_nickname?
    assert_nil user.preferred_name
    assert user.update(time_zone: "Tokyo", locale: "ja"), user.errors.full_messages.to_sentence

    user.editing_nickname = true
    assert_not user.update(nickname: "  ")
    user.editing_nickname = false
    user.reload
    assert user.update(nickname: "小雨")
    assert_not user.needs_nickname?
    assert_equal "小雨", user.preferred_name
    assert_not user.update(nickname: "")
    assert_equal "小雨", user.reload.nickname
  end

  test "platform agents are not asked for a nickname" do
    agent = new_user(nickname: nil)
    agent.platform_agent_of_id = 123
    assert_empty nickname_errors(agent)
    assert_not agent.needs_nickname?
  end

  test "the time of day follows fixed boundaries" do
    zone = ActiveSupport::TimeZone["Tokyo"]
    {0 => :evening, 4 => :evening, 5 => :morning, 11 => :morning, 12 => :afternoon, 17 => :afternoon, 18 => :evening, 23 => :evening}.each do |hour, part|
      assert_equal part, Personalization.day_part(zone.local(2026, 11, 17, hour, 0)), "#{hour}:00"
      assert_equal part, Personalization.day_part(zone.local(2026, 11, 17, hour, 59)), "#{hour}:59"
    end
  end

  test "messages greet by nickname when there is one, otherwise warmly without a name" do
    time = Time.zone.local(2026, 11, 17, 8)
    I18n.with_locale(:en) do
      assert_equal "Good morning, Jyun!", Personalization.greeting(name: "Jyun", time: time)
      assert_equal "Good morning!", Personalization.greeting(name: nil, time: time)
      assert_equal "Good morning!", Personalization.greeting(name: "   ", time: time)
      assert_equal "All set, Jyun! Your statement has been imported.", Personalization.message(:import_done, name: "Jyun")
      assert_equal "Looking good! Your transactions are reconciled.", Personalization.message(:reconciled)
    end
  end

  test "templates respect each language's word order and honorifics" do
    time = Time.zone.local(2026, 11, 17, 20)
    expected = {"en" => "Good evening, 小雨!", "zh-CN" => "晚上好，小雨！", "zh-TW" => "晚安，小雨！", "ja" => "小雨さん、こんばんは！",
                "ko" => "小雨님, 좋은 저녁이에요!", "es" => "¡Buenas noches, 小雨!"}
    expected.each do |locale, greeting|
      I18n.with_locale(locale) { assert_equal greeting, Personalization.greeting(name: "小雨", time: time) }
    end
  end

  test "every named message places the name and every plain message has none, in every language" do
    I18n.available_locales.each do |locale|
      catalog = I18n.t("billie.personalization", locale: locale)
      walk = lambda do |node, path|
        next unless node.is_a?(Hash)
        if node.key?(:named) && node.key?(:plain)
          assert_includes node[:named], "%{name}", "#{locale} #{path}"
          refute_includes node[:plain], "%{name}", "#{locale} #{path}"
        else
          node.each { |key, value| walk.call(value, "#{path}.#{key}") }
        end
      end
      walk.call(catalog, "personalization")
    end
  end

  test "the dashboard line invites new people in, notes things waiting without judgment, otherwise follows the day" do
    time = Time.zone.local(2026, 11, 17, 14)
    I18n.with_locale(:en) do
      assert_equal "Ready to understand your financial weather?", Personalization.dashboard_subtitle(time: time, has_transactions: false)
      assert_equal I18n.t("billie.personalization.dashboard.attention"), Personalization.dashboard_subtitle(time: time, has_transactions: true, needs_attention: true)
      assert_equal "Here's your latest financial outlook.", Personalization.dashboard_subtitle(time: time, has_transactions: true)
    end
  end

  test "the forecast outlook is honest: a projected gap, a lower range that dips, or stable; nothing without a balance" do
    today = Date.new(2026, 11, 17)
    point = ->(day, balance, lower = nil) { {date: today + day, balance: BigDecimal(balance.to_s), lower: lower && BigDecimal(lower.to_s)}.compact }
    assert_nil Personalization.forecast_outlook({balance_available: false, points: []})
    assert_nil Personalization.forecast_outlook(nil)
    assert_equal({kind: :stable}, Personalization.forecast_outlook({balance_available: true, points: [point.call(0, 500), point.call(30, 450)]}))
    assert_equal({kind: :range_dips}, Personalization.forecast_outlook({balance_available: true, points: [point.call(0, 500, 500), point.call(30, 200, -40)]}))
    assert_equal({kind: :gap, date: today + 12}, Personalization.forecast_outlook({balance_available: true, points: [point.call(0, 100), point.call(12, -5), point.call(30, -80)]}))
  end

  test "the apps' copy (personal.json) is generated from these translations and is up to date" do
    json = JSON.parse(File.read(Rails.root.join("clients/universal/src/i18n/personal.json")))
    convert = ->(value) { value.is_a?(Hash) ? value.transform_values { |item| convert.call(item) } : value.gsub(/%\{(\w+)\}/, '{\1}') }
    %w[en zh-CN zh-TW ja ko es].each do |locale|
      rails = YAML.load_file(Rails.root.join("config/locales/billie_personalization.#{locale}.yml")).dig(locale, "billie", "personalization").except("email")
      assert_equal convert.call(rails), json.fetch(locale), "#{locale}: run ruby clients/universal/scripts/sync-rails-translations.rb"
    end
  end
end
