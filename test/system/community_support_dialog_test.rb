require "application_system_test_case"
require "support/community_support_helpers"

class CommunitySupportDialogTest < ApplicationSystemTestCase
  include CommunitySupportHelpers

  test "the support modal opens without leaving the page, copies the payment note, enlarges a QR code, and closes with Esc" do
    friend = create(:user, nickname: "jyun", password: "a-long-test-password-1", password_confirmation: "a-long-test-password-1")
    invite(friend)
    Community::PAYMENT_METHODS.each { |key| store_qr(key) }

    with_support_payments do
      visit new_user_session_path(locale: "en")
      fill_in "user_email", with: friend.email
      fill_in "user_password", with: "a-long-test-password-1"
      find("form input[type='submit'], form button[type='submit']", match: :first).click
      assert_no_current_path new_user_session_path

      visit billie_features_path(locale: "en")
      # Record clipboard writes instead of touching the real clipboard.
      page.execute_script(<<~JS)
        Object.defineProperty(navigator, "clipboard", {configurable: true, value: {writeText: function (text) { window.__copied = text; return Promise.resolve(); }}});
      JS

      click_button "Support BillieWeather ❤️"
      assert_selector "dialog#support-dialog[open]"
      assert_current_path billie_features_path(locale: "en")
      assert_selector "dialog .bw-support-card", count: 4

      assert_text "Even $1 is enough to make a difference."
      click_button "Copy Note"
      assert_equal "jyun donation", page.evaluate_script("window.__copied")
      assert_selector ".bw-support-note .bw-copy-button", text: "Copied"

      # Enlarge opens a bigger view on top of the modal; Esc closes only that view.
      within(".bw-support-card[data-payment-method='zelle']") { click_link "Enlarge" }
      assert_selector "dialog#support-qr-zoom[open] img[src*='/support/payment-methods/zelle/qr']"
      assert_selector "dialog#support-qr-zoom[open] h3", text: "Zelle"
      find("dialog#support-qr-zoom").send_keys(:escape)
      assert_no_selector "dialog#support-qr-zoom[open]"
      assert_selector "dialog#support-dialog[open]"

      find("dialog#support-dialog").send_keys(:escape)
      assert_no_selector "dialog#support-dialog[open]"
      assert_equal ["member"], friend.reload.community_badges

      click_button "Support BillieWeather ❤️"
      find("dialog#support-dialog button[aria-label='Close']").click
      assert_no_selector "dialog#support-dialog[open]"

      # "Support us" in the header opens the same modal on other pages, without navigating.
      visit billie_about_path(locale: "en")
      find(".bw-public-links a", text: "Support us").click
      assert_selector "dialog#support-dialog[open] .bw-support-card", count: 4
      assert_current_path billie_about_path(locale: "en")
    end
  end
end
