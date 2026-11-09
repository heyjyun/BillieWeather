require "test_helper"
require "support/community_support_helpers"

# Admin → Payment Methods, and the privacy of the stored QR images.
class PaymentMethodsAdminTest < ActionDispatch::IntegrationTest
  include Devise::Test::IntegrationHelpers
  include CommunitySupportHelpers

  JPEG_BYTES = "\xFF\xD8\xFF\xE0\x00\x10JFIF\x00\x01\x01\x00\x00\x01\x00\x01\x00\x00\xFF\xD9".b

  setup do
    @admin = create(:user, nickname: "admin", email: "admin-#{SecureRandom.hex(4)}@example.com")
    @friend = create(:user, nickname: "jyun")
    invite(@friend, by: @admin)
  end

  def with_admin(&block)
    with_env("DEVELOPER_EMAILS" => @admin.email, &block)
  end

  def upload(bytes = PNG_BYTES, name: "qr.png", type: "image/png")
    upload_file(bytes, filename: name, content_type: type)
  end

  test "/supportadmin is a separate admin area: admins only after sign-in, its own sidebar, and no public or app links to it" do
    with_admin do
      assert_equal "/supportadmin", admin_root_path
      assert_equal "/supportadmin/community", admin_community_path
      assert_equal "/supportadmin/payment-methods", admin_payment_methods_path
      assert_equal "/supportadmin/payment-methods/venmo/qr", qr_admin_payment_method_path("venmo")

      [admin_root_path, admin_community_path, admin_payment_methods_path].each do |path|
        get path
        assert_redirected_to new_user_session_path
      end

      sign_in @friend
      [admin_root_path, admin_community_path, admin_payment_methods_path, admin_community_user_path(@friend)].each do |path|
        get path
        assert_response :not_found
      end

      sign_in @admin
      get admin_root_path, params: {locale: "en"}
      assert_response :success
      assert_select "h1", text: "Support admin"
      assert_select ".bw-admin-home-card[href='#{admin_community_path}']"
      assert_select ".bw-admin-home-card[href='#{admin_payment_methods_path}']"
      assert_select ".bw-admin-home-card[href='#{billie_features_path}']"
      # The admin sidebar replaces the app's: admin sections plus a way back, no finance pages.
      assert_select ".bw-nav a[href='#{admin_root_path}'][aria-current='page']", text: "Overview"
      assert_select ".bw-nav a[href='#{admin_community_path}']", text: "Community admin"
      assert_select ".bw-nav a[href='#{admin_payment_methods_path}']", text: "Payment methods"
      assert_select ".bw-nav a[href='#{billie_features_path}']", text: /Membership/
      assert_select ".bw-nav a[href='#{finance_dashboard_path}']", text: "Back to the app"
      assert_select ".bw-nav a[href='#{finance_transactions_path}']", count: 0
      assert_select ".bw-breadcrumb", text: /Support admin/

      # Nothing is mounted at /admin itself.
      assert_raises(ActionController::RoutingError) { Rails.application.routes.recognize_path("/admin", method: :get) }

      # Not linked from public pages or from the app, even for admins.
      [root_path, billie_about_path, billie_features_path, finance_dashboard_path, finance_settings_path].each do |path|
        get path, params: {locale: "en"}
        assert_select "a[href^='/admin'], a[href^='/supportadmin']", count: 0
      end

      %w[zh-CN zh-TW ja ko es].each do |locale|
        get admin_root_path, params: {locale: locale}
        assert_response :success
        assert_no_match(/translation_missing|Translation missing/, response.body)
      end
    end
  end

  test "Support us in the header opens the same support modal on every public page" do
    store_qr("alipay")
    with_support_payments do
      sign_in @friend
      [root_path, billie_about_path, billie_features_path].each do |path|
        get path, params: {locale: "en"}
        assert_response :success
        assert_includes response.headers["Cache-Control"], "no-store"
        assert_select ".bw-public-links a[data-dialog-open='support-dialog']", text: "Support us"
        assert_select "dialog#support-dialog[data-support-state='ready']", count: 1
        assert_select "dialog#support-dialog .bw-support-card[data-payment-method='alipay']"
      end
    end

    # Signed out, the modal is there but holds no QR codes.
    sign_out @friend
    with_support_payments do
      get root_path, params: {locale: "en"}
      assert_select "dialog#support-dialog[data-support-state='sign_in']"
      assert_select "img[src*='/support/payment-methods/']", count: 0
    end
    with_env("SUPPORT_PAYMENTS_ENABLED" => nil) do
      get billie_about_path, params: {locale: "en"}
      assert_select "dialog#support-dialog[data-support-state='coming_soon']"
    end
  end

  test "the page lists all four methods with upload, enable, and preview controls, even before any upload" do
    with_admin do
      sign_in @admin
      get admin_payment_methods_path, params: {locale: "en"}
      assert_response :success
      assert_includes response.headers["Cache-Control"], "no-store"
      assert_select "h1", text: "Payment Methods"
      Community::PAYMENT_METHODS.each do |key|
        assert_select "#payment-method-#{key}" do
          assert_select "input[type=file][name='payment_method[qr_upload]'][accept='image/png,image/jpeg,image/webp']"
          assert_select "input[type=checkbox][name='payment_method[enabled]']:not([checked])"
          assert_select "[data-qr-preview][hidden]"
          assert_select ".bw-support-qr-missing"
        end
      end
      assert_select ".bw-nav a[href='#{admin_payment_methods_path}'][aria-current='page']"

      %w[zh-CN zh-TW ja ko es].each do |locale|
        get admin_payment_methods_path, params: {locale: locale}
        assert_response :success
        assert_no_match(/translation_missing|Translation missing/, response.body)
      end
    end
  end

  test "upload, enable, preview, replace, disable, and remove a QR code without touching code or public files" do
    with_admin do
      sign_in @admin
      patch admin_payment_method_path("venmo"), params: {payment_method: {qr_upload: upload, enabled: "1", note_supported: "0"}}
      assert_redirected_to admin_payment_methods_path(anchor: "payment-method-venmo")
      venmo = Community::PaymentMethod.find_by!(key: "venmo")
      assert venmo.available?
      assert_not venmo.note_supported?
      assert_equal @admin, venmo.updated_by
      first_blob = venmo.qr_code.blob
      assert_equal "private_database", first_blob.service_name
      assert PrivateStorageFile.exists?(key: first_blob.key)
      assert_not File.exist?(Rails.public_path.join("venmo.png"))
      assert_not File.exist?(ActiveStorage::Blob.services.fetch(:test).path_for(first_blob.key))

      get admin_payment_methods_path, params: {locale: "en"}
      assert_select "#payment-method-venmo img.bw-support-qr[src^='#{community_payment_qr_path("venmo")}']"
      assert_select "#payment-method-venmo .bw-badge", text: "Shown in support modal"
      assert_no_match(%r{/rails/active_storage}, response.body)

      # Replace: the new image is served and the old bytes are deleted right away.
      patch admin_payment_method_path("venmo"), params: {payment_method: {qr_upload: upload(JPEG_BYTES, name: "new.jpg", type: "image/jpeg")}}
      venmo.reload
      assert_equal "image/jpeg", venmo.qr_content_type
      assert venmo.available?, "replacing the image keeps the method enabled"
      assert_not ActiveStorage::Blob.exists?(first_blob.id)
      assert_not PrivateStorageFile.exists?(key: first_blob.key)
      get community_payment_qr_path("venmo")
      assert_equal JPEG_BYTES, response.body.b

      # Disable: the image stays but friends no longer see it.
      patch admin_payment_method_path("venmo"), params: {payment_method: {enabled: "0", note_supported: "0"}}
      assert venmo.reload.qr_present?
      assert_not venmo.enabled?

      # Remove: bytes deleted and the method switched off.
      venmo.update!(enabled: true)
      second_key = venmo.qr_code.blob.key
      delete qr_admin_payment_method_path("venmo")
      assert_redirected_to admin_payment_methods_path(anchor: "payment-method-venmo")
      venmo.reload
      assert_not venmo.qr_present?
      assert_not venmo.enabled?
      assert_not PrivateStorageFile.exists?(key: second_key)
    end
  end

  test "bad uploads are refused and a method cannot be enabled without a QR code" do
    with_admin do
      sign_in @admin
      patch admin_payment_method_path("zelle"), params: {payment_method: {qr_upload: upload("<svg onload=alert(1)>", name: "zelle.png")}}
      follow_redirect!
      assert_select "[role='alert']", text: I18n.t("billie.community.admin.qr_wrong_type")
      assert_not Community::PaymentMethod.find_by(key: "zelle")&.qr_present?
      assert_equal 0, ActiveStorage::Blob.count

      patch admin_payment_method_path("zelle"), params: {payment_method: {enabled: "1"}}
      follow_redirect!
      assert_select "[role='alert']", text: I18n.t("billie.community.admin.qr_required_to_enable")
      assert_not Community::PaymentMethod.find_by(key: "zelle")&.enabled?
    end
  end

  test "only enabled methods reach the modal, and disabled ones are refused by the image endpoint" do
    store_qr("alipay", enabled: true)
    store_qr("zelle", enabled: false)
    with_support_payments do
      sign_in @friend
      get billie_features_path, params: {locale: "en"}
      assert_select ".bw-support-card", count: 1
      assert_select ".bw-support-card[data-payment-method='alipay']"
      get community_payment_qr_path("alipay")
      assert_response :success
      get community_payment_qr_path("zelle")
      assert_response :not_found

      Community::PaymentMethod.update_all(enabled: false)
      get billie_features_path, params: {locale: "en"}
      assert_select "dialog[data-support-state='coming_soon']"
      assert_select ".bw-support-card", count: 0
    end
  end

  test "Save image downloads the file; inline view is the default" do
    store_qr("wechat_pay")
    with_support_payments do
      sign_in @friend
      get community_payment_qr_path("wechat_pay")
      assert_match(/\Ainline/, response.headers["Content-Disposition"])
      get community_payment_qr_path("wechat_pay", download: 1)
      assert_match(/\Aattachment/, response.headers["Content-Disposition"])
      assert_includes response.headers["Content-Disposition"], "billieweather-wechat-pay-qr.png"
      assert_equal "nosniff", response.headers["X-Content-Type-Options"]
    end
  end

  test "Active Storage's own blob URLs refuse private QR blobs, even with a valid signed id" do
    blob = store_qr("alipay").qr_code.blob
    with_support_payments do
      sign_in @friend
      get rails_service_blob_proxy_path(blob.signed_id, blob.filename)
      assert_response :not_found
      get rails_service_blob_path(blob.signed_id, blob.filename)
      assert_response :not_found
    end
    assert_raises(ActiveStorage::Error) { blob.url }
  end

  test "the no-note-field help shows the contact email when SUPPORT_CONTACT_EMAIL is set" do
    store_qr("zelle", note_supported: false)
    with_support_payments do
      sign_in @friend
      with_env("SUPPORT_CONTACT_EMAIL" => nil) do
        get billie_features_path, params: {locale: "en"}
        assert_select ".bw-support-card[data-payment-method='zelle'] .bw-support-warning"
        assert_select ".bw-support-manual", text: /message the developer/
        assert_select ".bw-support-manual a[href^='mailto:']", count: 0
      end
      with_env("SUPPORT_CONTACT_EMAIL" => "support@example.com") do
        get billie_features_path, params: {locale: "en"}
        assert_select ".bw-support-manual a[href^='mailto:support@example.com']", text: "support@example.com"
      end
    end
  end
end
