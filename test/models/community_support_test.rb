require "test_helper"
require "support/community_support_helpers"

class CommunitySupportModelTest < ActiveSupport::TestCase
  include CommunitySupportHelpers

  setup do
    @admin = create(:user, nickname: "admin")
    @user = create(:user, nickname: "jyun")
  end

  test "payment note is the nickname followed by a single space and lowercase donation" do
    assert_equal "jyun donation", Community.payment_note_for(@user)
    @user.update!(nickname: "  Jyun   Z  ")
    assert_equal "Jyun Z donation", Community.payment_note_for(@user)
    assert_match(/\A\S.* donation\z/, @user.support_payment_note)
  end

  test "payment note never falls back to the email address" do
    @user.update!(nickname: nil)
    assert_nil Community.payment_note_for(@user)
    assert_nil @user.support_payment_note
    assert_nil Community.payment_note_for(nil)
  end

  test "every account is a Member and the founding badges stack without replacing each other" do
    assert_equal ["member"], @user.community_badges
    Community::Honor.grant!(user: @user, kind: "founding_member", by: @admin)
    Community::Honor.grant!(user: @user, kind: "founding_patron", by: @admin, payment_method: "zelle", confirmed_at: Time.current)
    assert_equal %w[member founding_member founding_patron], @user.reload.community_badges
    assert @user.founding_member?
    assert @user.founding_patron?
  end

  test "the same active badge cannot be granted twice, but can be re-granted after a revoke" do
    first = Community::Honor.grant!(user: @user, kind: "founding_member", by: @admin)
    error = assert_raises(ActiveRecord::RecordInvalid) { Community::Honor.grant!(user: @user, kind: "founding_member", by: @admin) }
    assert_includes error.record.errors.full_messages, I18n.t("billie.community.admin.duplicate_badge")
    assert_equal 1, @user.community_honors.count

    first.revoke!(by: @admin, reason: "granted by mistake")
    assert_not @user.reload.founding_member?
    assert_equal "granted by mistake", first.reload.revoke_reason
    assert_equal @admin, first.revoked_by

    Community::Honor.grant!(user: @user, kind: "founding_member", by: @admin)
    assert @user.reload.founding_member?
    assert_equal 2, @user.community_honors.count
  end

  test "the database also refuses a second active badge of the same kind" do
    Community::Honor.grant!(user: @user, kind: "founding_member", by: @admin)
    duplicate = Community::Honor.new(user: @user, kind: "founding_member", granted_at: Time.current)
    assert_raises(ActiveRecord::RecordNotUnique) { duplicate.save!(validate: false) }
  end

  test "Founding Patron requires the payment method and confirmation time" do
    honor = Community::Honor.new(user: @user, kind: "founding_patron", granted_by: @admin)
    assert_not honor.valid?
    assert_includes honor.errors.full_messages, I18n.t("billie.community.admin.patron_requires_confirmation")
    honor.assign_attributes(payment_method: "alipay", confirmed_at: Time.current)
    assert honor.valid?
    assert_not Community::Honor.new(user: @user, kind: "admin", granted_by: @admin).valid?
  end

  test "badges are recognition only and do not touch Bullet Train roles or developer access" do
    Community::Honor.grant!(user: @user, kind: "founding_patron", by: @admin, payment_method: "venmo", confirmed_at: Time.current)
    assert_not @user.reload.developer?
    assert_not_includes Community::Honor.column_names, "role"
  end

  test "payments are off unless SUPPORT_PAYMENTS_ENABLED is explicitly true" do
    with_env("SUPPORT_PAYMENTS_ENABLED" => nil) { assert_not Community.payments_enabled? }
    with_env("SUPPORT_PAYMENTS_ENABLED" => "false") { assert_not Community.payments_enabled? }
    with_env("SUPPORT_PAYMENTS_ENABLED" => "yes please") { assert_not Community.payments_enabled? }
    with_env("SUPPORT_PAYMENTS_ENABLED" => "true") { assert Community.payments_enabled? }
  end

  test "QR uploads are detected by content and limited to PNG, JPEG, or WebP up to 2 MB" do
    method = Community::PaymentMethod.for("alipay")
    method.qr_upload = StringIO.new(PNG_BYTES)
    assert method.save
    assert_equal "image/png", method.qr_content_type
    assert_equal "private_database", method.qr_code.blob.service_name

    svg = Community::PaymentMethod.for("venmo")
    svg.qr_upload = StringIO.new(%(<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>))
    assert_not svg.save

    disguised = Community::PaymentMethod.for("zelle")
    disguised.qr_upload = upload_file("not really an image", filename: "qr.png", content_type: "image/png")
    assert_not disguised.save

    huge = Community::PaymentMethod.for("wechat_pay")
    huge.qr_upload = StringIO.new(PNG_BYTES + ("0" * Community::PaymentMethod::MAX_BYTES))
    assert_not huge.save
    assert_includes huge.errors.full_messages.join, "2 MB"
  end

  test "support access can be granted, re-granted idempotently, and revoked" do
    assert_not @user.support_payments_viewer?
    invite(@user, by: @admin)
    invite(@user, by: @admin)
    assert_equal 1, Community::SupportAccess.where(user: @user).count
    assert @user.reload.support_payments_viewer?
    @user.community_support_access.revoke!(by: @admin)
    assert_not @user.reload.support_payments_viewer?
  end

  test "deleting an account removes its badges and access, and deleting an admin keeps the records" do
    Community::Honor.grant!(user: @user, kind: "founding_member", by: @admin)
    invite(@user, by: @admin)
    @admin.destroy!
    honor = @user.community_honors.reload.first
    assert_nil honor.granted_by_id
    @user.destroy!
    assert_equal 0, Community::Honor.count
    assert_equal 0, Community::SupportAccess.count
  end
end
