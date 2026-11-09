require "test_helper"
require "support/community_support_helpers"

class CommunitySupportTest < ActionDispatch::IntegrationTest
  include Devise::Test::IntegrationHelpers
  include CommunitySupportHelpers

  setup do
    @admin = create(:user, nickname: "admin", email: "admin-#{SecureRandom.hex(4)}@example.com")
    @friend = create(:user, nickname: "jyun")
    @stranger = create(:user, nickname: "stranger")
    Community::PAYMENT_METHODS.each { |key| store_qr(key) }
  end

  def with_admin(&block)
    with_env("DEVELOPER_EMAILS" => @admin.email, &block)
  end

  def assert_no_qr_codes
    assert_select ".bw-support-card", count: 0
    assert_select "img[src*='/support/payment-methods/']", count: 0
    assert_no_match(/donation<\/code>/, response.body)
  end

  test "Features & Membership is public, linked in the header, localized, and shows the benefits table" do
    get billie_features_path, params: {locale: "en"}
    assert_response :success
    assert_select ".bw-public-links a[href='#{billie_features_path}'][aria-current='page']", text: "Features & Membership"
    %w[Financial\ Dashboard Smart\ Categorization Cash\ Flow\ Forecasting AI\ Financial\ Insights Tax\ Preparation\ Assistance].each do |feature|
      assert_select ".bw-feature-card h3", text: feature
    end
    assert_includes response.body, "BillieWeather is currently independently developed and funded out of pocket, including cloud hosting, database infrastructure, AI API token costs, and ongoing maintenance. Our goal is to keep personal finance tools accessible to everyone."
    assert_select ".bw-benefits-table tbody tr", count: 6
    assert_select ".bw-benefits-table tbody tr:last-child td.bw-benefit-yes", count: 1
    assert_select ".bw-benefits-table tbody tr:first-child td.bw-benefit-yes", count: 3
    assert_select "button[data-dialog-open='support-dialog']", text: "Support BillieWeather ❤️"
    assert_select "dialog#support-dialog h2", text: "Support BillieWeather"
    assert_includes response.body, "Your voluntary support helps cover hosting, infrastructure, and AI costs. Thank you for helping BillieWeather grow."

    %w[en zh-CN zh-TW ja ko es].each do |locale|
      get billie_features_path, params: {locale: locale}
      assert_response :success
      assert_select "html[lang='#{locale}']"
      assert_no_match(/translation_missing|Translation missing/, response.body)
    end
  end

  test "payments are off by default: everyone, even invited friends, sees Coming Soon and no QR codes" do
    invite(@friend, by: @admin)
    with_env("SUPPORT_PAYMENTS_ENABLED" => nil) do
      get billie_features_path, params: {locale: "en"}
      assert_select "dialog[data-support-state='coming_soon'] h3", text: "Coming Soon"
      assert_no_qr_codes

      sign_in @friend
      get billie_features_path
      assert_select "dialog[data-support-state='coming_soon']"
      assert_no_qr_codes
      get community_payment_qr_path("alipay")
      assert_response :not_found
    end
  end

  test "signed-out visitors are asked to sign in and cannot load QR images" do
    with_support_payments do
      get billie_features_path, params: {locale: "en"}
      assert_select "dialog[data-support-state='sign_in']"
      assert_select "dialog a[href='#{new_user_session_path}']"
      assert_no_qr_codes

      get community_payment_qr_path("alipay")
      assert_redirected_to new_user_session_path
    end
  end

  test "signed-in people who were not invited see no QR codes and get 404 from the image endpoint" do
    with_support_payments do
      sign_in @stranger
      get billie_features_path, params: {locale: "en"}
      assert_select "dialog[data-support-state='not_invited']"
      assert_no_qr_codes
      Community::PAYMENT_METHODS.each do |key|
        get community_payment_qr_path(key)
        assert_response :not_found
      end
    end
  end

  test "invited friends see four QR cards, the encouragement, how-to steps, and one read-only nickname note with Copy Note" do
    invite(@friend, by: @admin)
    with_support_payments do
      sign_in @friend
      get billie_features_path, params: {locale: "en"}
      assert_response :success
      assert_includes response.headers["Cache-Control"], "no-store"
      assert_select "dialog[data-support-state='ready']"
      assert_select ".bw-support-grid .bw-support-card", count: 4
      ["Alipay — 支付宝", "WeChat Pay — 微信支付", "Zelle", "Venmo"].each do |label|
        assert_select ".bw-support-card h3", text: label
      end
      assert_select ".bw-support-encourage", text: "Even $1 is enough to make a difference. Every little bit helps keep BillieWeather free and growing. ❤️"
      assert_select ".bw-support-howto h3", text: "How to Support"
      assert_select ".bw-support-howto ol li", count: 4
      assert_select ".bw-support-howto li", text: "Contributions are manually verified before Founding Patron recognition is granted."
      assert_select ".bw-support-note-label", text: "Payment Note / 付款备注", count: 1
      assert_select ".bw-support-note-row code", text: "jyun donation", count: 1
      assert_select "button.bw-copy-button[data-copy-text='jyun donation']", text: "Copy Note", count: 1
      # The note is display-only: no field to edit it, nickname or anyone else's.
      assert_select "dialog#support-dialog input, dialog#support-dialog textarea", count: 0
      Community::PAYMENT_METHODS.each do |key|
        assert_select ".bw-support-card[data-payment-method='#{key}'] a[data-qr-zoom]", minimum: 1
        assert_select ".bw-support-card[data-payment-method='#{key}'] a[download][href*='download=1']", count: 1
      end
      assert_not_includes response.body, "#{@friend.email} donation"
      assert_select "img.bw-support-qr", count: 4
      # Never a public Active Storage or /public URL.
      assert_no_match(%r{/rails/active_storage|src="/qr}, response.body)

      get community_payment_qr_path("wechat_pay")
      assert_response :success
      assert_equal "image/png", response.media_type
      assert_includes response.headers["Cache-Control"], "no-store"
      assert_equal PNG_BYTES, response.body.b
    end
  end

  test "a service without a note field tells people how to get their payment matched by hand" do
    store_qr("zelle", note_supported: false)
    invite(@friend, by: @admin)
    with_support_payments do
      sign_in @friend
      get billie_features_path, params: {locale: "en"}
      assert_select ".bw-support-card[data-payment-method='zelle'] .bw-support-warning", count: 1
      assert_select ".bw-support-card[data-payment-method='venmo'] .bw-support-warning", count: 0
    end
  end

  test "invited friends without a nickname are sent to set one instead of falling back to their email" do
    @friend.update!(nickname: nil)
    invite(@friend, by: @admin)
    with_support_payments do
      sign_in @friend
      get billie_features_path, params: {locale: "en"}
      assert_select "dialog[data-support-state='nickname_required']"
      assert_select "dialog a[href='#{finance_settings_path(anchor: "settings-profile")}']"
      assert_no_qr_codes
      assert_not_includes response.body, "#{@friend.email} donation"
    end
  end

  test "opening the support modal never upgrades anyone's badges" do
    invite(@friend, by: @admin)
    with_support_payments do
      sign_in @friend
      assert_no_difference -> { Community::Honor.count } do
        get billie_features_path
        get community_payment_qr_path("alipay")
      end
      assert_equal ["member"], @friend.reload.community_badges
    end
  end

  test "admin pages and actions are refused on the server for non-admins and signed-out visitors" do
    with_admin do
      get admin_community_path
      assert_redirected_to new_user_session_path

      sign_in @stranger
      get admin_community_path
      assert_response :not_found
      get admin_community_user_path(@friend)
      assert_response :not_found
      assert_no_difference -> { Community::Honor.count } do
        post admin_community_user_honors_path(@stranger), params: {honor: {kind: "founding_patron", payment_method: "zelle", confirmed_at: "2026-11-01T10:00"}}
      end
      assert_response :not_found
      post admin_community_user_support_access_path(@stranger)
      assert_response :not_found
      assert_not @stranger.reload.support_payments_viewer?
      get admin_payment_methods_path
      assert_response :not_found
      patch admin_payment_method_path("alipay"), params: {payment_method: {qr_upload: upload_file(PNG_BYTES, filename: "x.png", content_type: "image/png")}}
      assert_response :not_found
      patch admin_payment_method_path("venmo"), params: {payment_method: {enabled: "0"}}
      assert_response :not_found
      delete qr_admin_payment_method_path("venmo")
      assert_response :not_found
      assert Community::PaymentMethod.find_by(key: "venmo").available?
    end
  end

  test "admins find people by nickname, grant stacked badges, record confirmation details, and revoke mistakes" do
    with_admin do
      sign_in @admin
      get admin_community_path, params: {q: "jyu", locale: "en"}
      assert_response :success
      assert_select "td", text: "jyun"
      assert_select "a[href='#{admin_community_user_path(@friend)}']"
      assert_select "td", text: "stranger", count: 0

      post admin_community_user_honors_path(@friend), params: {honor: {kind: "founding_member", note: "beta tester"}}
      assert_redirected_to admin_community_user_path(@friend)
      post admin_community_user_honors_path(@friend), params: {honor: {kind: "founding_patron", payment_method: "alipay", confirmed_at: "2026-11-01T10:30", note: "matched note jyun donation"}}
      assert_redirected_to admin_community_user_path(@friend)
      assert_equal %w[member founding_member founding_patron], @friend.reload.community_badges
      patron = @friend.community_honors.find_by(kind: "founding_patron")
      assert_equal "alipay", patron.payment_method
      assert_equal @admin, patron.granted_by
      assert_equal "matched note jyun donation", patron.note
      assert_not_nil patron.confirmed_at

      # Duplicate grant is refused with a clear message.
      assert_no_difference -> { Community::Honor.count } do
        post admin_community_user_honors_path(@friend), params: {honor: {kind: "founding_patron", payment_method: "zelle", confirmed_at: "2026-11-02T10:00"}}
      end
      follow_redirect!
      assert_select "[role='alert']", text: I18n.t("billie.community.admin.duplicate_badge")

      # Patron without confirmation details is refused.
      @stranger.update!(nickname: "stranger")
      post admin_community_user_honors_path(@stranger), params: {honor: {kind: "founding_patron"}}
      assert_not @stranger.reload.founding_patron?

      get admin_community_user_path(@friend)
      assert_response :success
      assert_select ".bw-honor-founding-patron"
      assert_select ".bw-honor-founding-member"

      patch revoke_admin_community_user_honor_path(@friend, patron), params: {honor: {revoke_reason: "wrong person"}}
      assert_redirected_to admin_community_user_path(@friend)
      assert_equal %w[member founding_member], @friend.reload.community_badges
      assert_equal "wrong person", patron.reload.revoke_reason
      assert_equal @admin, patron.revoked_by
    end
  end

  test "admins invite friends to see QR codes" do
    with_admin do
      sign_in @admin
      post admin_community_user_support_access_path(@friend)
      assert @friend.reload.support_payments_viewer?
      delete admin_community_user_support_access_path(@friend)
      assert_not @friend.reload.support_payments_viewer?
    end
  end

  test "only Founding Patrons who opt in are listed publicly, by nickname only" do
    Community::Honor.grant!(user: @friend, kind: "founding_patron", by: @admin, payment_method: "zelle", confirmed_at: Time.current, note: "private admin note")
    get billie_features_path, params: {locale: "en"}
    assert_select ".bw-supporters", count: 0

    sign_in @friend
    get finance_settings_path, params: {locale: "en"}
    assert_select "#settings-community .bw-honor-founding-patron"
    patch supporter_recognition_finance_settings_path, params: {user: {supporter_recognition_public: "1"}}
    assert @friend.reload.supporter_recognition_public?

    sign_out @friend
    get billie_features_path
    assert_select ".bw-supporters li", text: /jyun/
    assert_not_includes response.body, "private admin note"
    assert_not_includes response.body, @friend.email

    sign_in @stranger
    patch supporter_recognition_finance_settings_path, params: {user: {supporter_recognition_public: "1"}}
    assert_response :forbidden
    assert_not @stranger.reload.supporter_recognition_public?
  end

  test "the app sidebar keeps only core features: no Membership or admin links, even for admins" do
    with_admin do
      [@stranger, @admin].each do |user|
        sign_in user
        get finance_settings_path, params: {locale: "en"}
        assert_select ".bw-nav a[href='#{finance_dashboard_path}']"
        assert_select ".bw-nav a[href='#{billie_features_path}']", count: 0
        assert_select ".bw-nav a[href='#{admin_community_path}']", count: 0
        assert_select ".bw-nav a[href='#{admin_payment_methods_path}']", count: 0
      end
    end
  end
end
