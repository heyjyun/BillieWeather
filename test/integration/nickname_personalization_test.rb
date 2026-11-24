require "test_helper"
require_relative "../support/billie_method_stub"

# Required nickname on every sign-up path, the gentle prompt for older accounts, and the places the
# website greets people by name. The nickname is private: it is never shown to anyone else.
class NicknamePersonalizationTest < ActionDispatch::IntegrationTest
  include Devise::Test::IntegrationHelpers
  # Exercises optional modules (hidden by default since the Feature Library): sign people in with them on.
  include BillieModules::SignInWithAllModules
  include ActionMailer::TestHelper
  include BillieMethodStub

  PASSWORD = "Gr33nCloud!Rain&2026"

  def registration_params(email, **attributes)
    {user: {email: email, usage_region: "US", password: PASSWORD, password_confirmation: PASSWORD}.merge(attributes)}
  end

  def legacy_user(**attributes)
    create(:onboarded_user, **attributes).tap { |user| user.update_column(:nickname, nil) }.reload
  end

  # ---- sign-up -------------------------------------------------------------------------------

  test "the sign-up form asks for a required nickname with a friendly explanation" do
    get new_user_registration_path, params: {locale: "en"}
    assert_response :success
    assert_select "label[for='user_nickname']", text: /\ANickname\s*\*\s*\(required\)\z/
    refute_includes response.body, "Nickname (optional)"
    assert_select "input#user_nickname[required][maxlength='40'][placeholder='What should we call you?'][aria-describedby='user_nickname_help']"
    assert_select "#user_nickname_help", text: "We'll use your nickname to make BillieWeather feel a little more personal. Up to 40 characters, in any language."
  end

  test "email sign-up refuses a missing or whitespace-only nickname and creates nothing" do
    [nil, "", "   ", "​"].each do |nickname|
      assert_no_difference "User.count" do
        post user_registration_path, params: registration_params("blank-#{SecureRandom.hex(3)}@example.com", nickname: nickname)
      end
      assert_response :unprocessable_entity
      assert_select "[role='alert']", text: /Nickname/
      assert_select "input#user_nickname[aria-invalid='true']"
    end
  end

  test "email sign-up keeps a Unicode nickname and welcomes the person by it" do
    assert_difference "User.count", 1 do
      post user_registration_path, params: registration_params("unicode@example.com", nickname: "  小雨  ")
    end
    assert_redirected_to finance_dashboard_path
    assert_equal "小雨", User.find_by!(email: "unicode@example.com").nickname
    assert_equal "Welcome to BillieWeather, 小雨! Let's make your financial future a little clearer.", flash[:notice]
  end

  test "the sign-up error for a blank nickname is localized" do
    post user_registration_path(locale: "ja"), params: registration_params("ja-blank@example.com", nickname: " ")
    assert_response :unprocessable_entity
    assert_select "[role='alert']", text: /ニックネームを入力してください/
  end

  # ---- Google sign-up (website) --------------------------------------------------------------

  class GoogleSignUp < ActionDispatch::IntegrationTest
    setup do
      @previous = {test_mode: OmniAuth.config.test_mode, mock: OmniAuth.config.mock_auth.dup, id: ENV["GOOGLE_CLIENT_ID"], secret: ENV["GOOGLE_CLIENT_SECRET"]}
      OmniAuth.config.test_mode = true
      OmniAuth.config.mock_auth[:google_oauth2] = OmniAuth::AuthHash.new(provider: "google_oauth2", uid: "nickname-google-subject",
        info: {email: "nick-google@example.com", name: "Legal Google Name"},
        extra: {id_info: {sub: "nickname-google-subject", email: "nick-google@example.com", email_verified: true}})
      ENV["GOOGLE_CLIENT_ID"] = "test-client"
      ENV["GOOGLE_CLIENT_SECRET"] = "test-secret"
    end

    teardown do
      OmniAuth.config.test_mode = @previous[:test_mode]
      OmniAuth.config.mock_auth = @previous[:mock]
      @previous[:id].nil? ? ENV.delete("GOOGLE_CLIENT_ID") : ENV["GOOGLE_CLIENT_ID"] = @previous[:id]
      @previous[:secret].nil? ? ENV.delete("GOOGLE_CLIENT_SECRET") : ENV["GOOGLE_CLIENT_SECRET"] = @previous[:secret]
    end

    test "a new Google account completes a nickname step; the Google profile name is never used" do
      get user_google_oauth2_omniauth_callback_path
      assert_redirected_to new_google_region_path
      follow_redirect!
      assert_select "input#user_nickname[required]"
      assert_select "input#user_nickname[value]", count: 0 # nothing guessed from the Google profile

      assert_no_difference "User.count" do
        post google_region_path, params: {user: {usage_region: "JP", nickname: "  "}}
      end
      assert_response :unprocessable_entity
      assert_select "[role='alert']", text: /Nickname/

      assert_difference "User.count", 1 do
        post google_region_path, params: {user: {usage_region: "JP", nickname: "ジュン"}}
      end
      user = User.find_by!(google_uid: "nickname-google-subject")
      assert_equal "ジュン", user.nickname
      refute_includes user.attributes.values.compact.map(&:to_s).join(" "), "Legal Google Name"
      assert_includes flash[:notice], "ジュン"
    end
  end

  # ---- older accounts without a nickname -----------------------------------------------------

  test "an older account without a nickname still signs in and sees a dismissible suggestion, not a block" do
    user = legacy_user(password: PASSWORD, password_confirmation: PASSWORD)
    post user_session_path, params: {user: {email: user.email, password: PASSWORD}}
    assert_redirected_to finance_dashboard_path
    follow_redirect!
    assert_response :success
    assert_select "#nickname-prompt h2", text: "What should we call you?"
    assert_select "h1#dashboard-greeting", text: /\AGood (morning|afternoon|evening)!\z/
    refute_includes css_select("h1#dashboard-greeting").text, user.email

    post dismiss_nickname_prompt_finance_settings_path
    assert_redirected_to finance_dashboard_path
    follow_redirect!
    assert_select "#nickname-prompt", count: 0
    assert_nil user.reload.nickname
  end

  test "saving from the suggestion returns to the dashboard and greets by the new nickname" do
    user = legacy_user
    sign_in user
    patch nickname_finance_settings_path, params: {return_to: "dashboard", user: {nickname: "   "}}
    assert_redirected_to finance_dashboard_path
    assert_match(/Nickname/, flash[:alert])
    assert_nil user.reload.nickname

    patch nickname_finance_settings_path, params: {return_to: "dashboard", user: {nickname: " 김윤 "}}
    assert_redirected_to finance_dashboard_path
    assert_equal "Nice to meet you, 김윤!", flash[:notice]
    follow_redirect!
    assert_select "#nickname-prompt", count: 0
    assert_select "h1#dashboard-greeting", text: /김윤/
  end

  # ---- account settings ----------------------------------------------------------------------

  test "settings can change the nickname but not clear it" do
    user = create(:onboarded_user, nickname: "Sunny")
    sign_in user
    get finance_settings_path, params: {locale: "en"}
    assert_select "input#user_nickname[required][value='Sunny']"
    patch nickname_finance_settings_path, params: {user: {nickname: "  "}}
    assert_response :unprocessable_entity
    assert_equal "Sunny", user.reload.nickname
    patch nickname_finance_settings_path, params: {user: {nickname: "Sunny Day"}}
    assert_redirected_to finance_settings_path
    assert_equal "Sunny Day", user.reload.nickname
  end

  # ---- dashboard greeting --------------------------------------------------------------------

  test "the dashboard greets by nickname for the person's own time of day and language" do
    user = create(:onboarded_user, nickname: "Jyun", time_zone: "Tokyo")
    sign_in user
    travel_to Time.utc(2026, 11, 17, 23, 30) do # 08:30 in Tokyo
      get finance_dashboard_path, params: {locale: "en"}
      assert_select "h1#dashboard-greeting[data-day-part='morning']", text: "Good morning, Jyun!"
      # Nothing imported yet; the name is said once, in the greeting, not again underneath.
      assert_select "#dashboard-greeting-subtitle", text: "Ready to understand your financial weather?"
      assert_select "#dashboard-greeting .bw-greeting-glyph[aria-hidden='true']"
    end
    travel_to Time.utc(2026, 11, 17, 5, 0) do # 14:00 in Tokyo
      get finance_dashboard_path, params: {locale: "zh-CN"}
      assert_select "h1#dashboard-greeting", text: "下午好，Jyun！"
    end
    travel_to Time.utc(2026, 11, 17, 11, 0) do # 20:00 in Tokyo
      get finance_dashboard_path, params: {locale: "ja"}
      assert_select "h1#dashboard-greeting", text: "Jyunさん、こんばんは！"
    end
  end

  test "nobody sees another person's nickname, and signed-out visitors are sent to sign in" do
    other = create(:onboarded_user, nickname: "PrivateOther")
    me = create(:onboarded_user, nickname: "Me")
    get finance_dashboard_path
    assert_redirected_to new_user_session_path
    sign_in me
    [finance_dashboard_path, finance_settings_path, finance_forecast_path, finance_insights_path, finance_reconciliation_path].each do |path|
      get path, params: {locale: "en"}
      assert_response :success
      refute_includes response.body, other.nickname, path
    end
  end

  # ---- client API (the apps) -----------------------------------------------------------------

  test "the apps can update the nickname with the same rules, and only for the signed-in account" do
    user = create(:onboarded_user, nickname: "jyun", password: PASSWORD, password_confirmation: PASSWORD)
    other = create(:onboarded_user, nickname: "Other")
    post "/api/client/v1/session", params: {email: user.email, password: PASSWORD}, as: :json
    headers = {"Authorization" => "Bearer #{response.parsed_body.fetch("token")}"}

    patch "/api/client/v1/account", params: {account: {nickname: " 　 "}}, headers: headers, as: :json
    assert_response :unprocessable_content
    assert_equal({"nickname" => ["blank"]}, response.parsed_body["fields"])
    assert_equal "jyun", user.reload.nickname

    patch "/api/client/v1/account", params: {account: {nickname: " 小雨 "}}, headers: headers, as: :json
    assert_response :success
    assert_equal "小雨", response.parsed_body.dig("account", "nickname")
    assert_equal "Other", other.reload.nickname

    patch "/api/client/v1/account", params: {account: {nickname: "x"}}, as: :json
    assert_response :unauthorized
    assert_equal "小雨", user.reload.nickname
  end

  test "an older account without a nickname keeps working in the apps" do
    user = legacy_user(password: PASSWORD, password_confirmation: PASSWORD)
    post "/api/client/v1/session", params: {email: user.email, password: PASSWORD}, as: :json
    assert_response :created
    assert_nil response.parsed_body.dig("account", "nickname")
    headers = {"Authorization" => "Bearer #{response.parsed_body.fetch("token")}"}
    patch "/api/client/v1/account", params: {account: {locale: "ja"}}, headers: headers, as: :json
    assert_response :success
  end

  # ---- import, forecast, welcome email -------------------------------------------------------

  test "a successful import is acknowledged by name" do
    user = create(:onboarded_user, nickname: "Jyun")
    sign_in user
    Tempfile.create(["billie-test", ".csv"]) do |file|
      file.write("Date,Description,Amount\n2026-11-01,Salary deposit,4200.00\n2026-11-03,Grocery market,-86.35\n")
      file.rewind
      post finance_statements_path(locale: "en"), params: {file: Rack::Test::UploadedFile.new(file.path, "text/csv", original_filename: "nov.csv")}
    end
    assert_redirected_to finance_transactions_path
    assert flash[:notice].start_with?("All set, Jyun! Your statement has been imported. ")
  end

  test "a forecast with a projected gap is described calmly, with the date and what to try" do
    user = create(:onboarded_user, nickname: "Jyun")
    sign_in user
    gap = {balance_available: true, days: 30, method: :linear, current_balance: 100, projected_balance: -50, history_days: 60,
           daily_income: 0, daily_expenses: 5, points: [{date: Date.current, balance: BigDecimal("100")}, {date: Date.current + 21, balance: BigDecimal("-5")}]}
    forecast = Finance::CashFlowForecast.new(user: user)
    projected = forecast.to_h.merge(gap)
    stub_method(Finance::CashFlowForecast, :new, forecast) do
      stub_method(forecast, :to_h, projected) do
        get finance_forecast_path, params: {locale: "en"}
      end
    end
    assert_response :success
    assert_select "#forecast-outlook.bw-outlook-gap[role='status'] .bw-outlook-message", text: /\AJyun, there may be a cash flow gap ahead around .+\. Let's explore your options\.\z/
    assert_select "#forecast-outlook .bw-outlook-help", text: /not a certainty/
    refute_match(/spending too much|overspend/i, response.body)
  end

  test "the welcome email is in the sign-up language and greets by nickname" do
    post user_registration_path(locale: "es"), params: registration_params("welcome-mail@example.com", nickname: "Lluvia")
    assert_redirected_to finance_dashboard_path
    mail = ActionMailer::Base.deliveries.reverse.find { |message| message.to.include?("welcome-mail@example.com") }
    assert mail, "no welcome email was delivered"
    assert_equal "¡Te damos la bienvenida a BillieWeather!", mail.subject
    assert_includes mail.html_part.body.to_s, "¡Te damos la bienvenida a BillieWeather, Lluvia!"
    refute_includes mail.html_part.body.to_s, "Untitled Application"
  end
end
