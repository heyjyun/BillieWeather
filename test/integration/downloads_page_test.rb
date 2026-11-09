require "test_helper"
require "support/community_support_helpers"

class DownloadsPageTest < ActionDispatch::IntegrationTest
  include CommunitySupportHelpers

  NO_LINKS = {"DOWNLOAD_MAC_URL" => nil, "DOWNLOAD_WINDOWS_URL" => nil}.freeze

  test "the header links to a separate Download page; the homepage itself has no download section" do
    with_env(NO_LINKS) do
      [root_path, billie_about_path, billie_features_path, new_user_session_path].each do |path|
        get path, params: {locale: "zh-CN"}
        assert_select ".bw-public-links a[href='#{billie_download_path}']", text: "下载"
      end
      get root_path, params: {locale: "en"}
      assert_select ".bw-download-card", count: 0
      assert_select "#download", count: 0

      get billie_download_path, params: {locale: "en"}
      assert_response :success
      assert_select "title", text: /Download BillieWeather/
      assert_select ".bw-public-links a[href='#{billie_download_path}'][aria-current='page']", text: "Download"
      assert_select ".bw-download-card", count: 4
    end
  end

  test "iOS and Android are always greyed out, not clickable, and marked in development" do
    with_env("DOWNLOAD_MAC_URL" => "https://example.com/mac.dmg", "DOWNLOAD_WINDOWS_URL" => "https://example.com/win.exe") do
      get billie_download_path, params: {locale: "zh-CN"}
      assert_response :success
      assert_select "h1", text: "下载 BillieWeather"
      %w[ios android].each do |key|
        assert_select ".bw-download-card[data-platform='#{key}'].bw-download-in-development" do
          assert_select "a", count: 0
          assert_select ".bw-download-disabled[aria-disabled='true']"
          assert_select ".bw-download-note", text: "开发中"
        end
      end
    end
  end

  test "macOS and Windows link to the configured https installers" do
    with_env("DOWNLOAD_MAC_URL" => "https://example.com/BillieWeather.dmg", "DOWNLOAD_WINDOWS_URL" => "https://example.com/BillieWeather-setup.exe") do
      get billie_download_path, params: {locale: "en"}
      assert_select ".bw-download-card[data-platform='mac'] a.bw-download-button[href='https://example.com/BillieWeather.dmg']", text: "Download"
      assert_select ".bw-download-card[data-platform='windows'] a.bw-download-button[href='https://example.com/BillieWeather-setup.exe']", text: "Download"
    end
  end

  test "without a hosted installer, desktop buttons say coming soon instead of linking nowhere" do
    with_env(NO_LINKS) do
      get billie_download_path, params: {locale: "en"}
      %w[mac windows].each do |key|
        assert_select ".bw-download-card[data-platform='#{key}'] a", count: 0
        assert_select ".bw-download-card[data-platform='#{key}'] .bw-download-disabled", text: "Coming soon"
      end
    end
  end

  test "non-https or malformed links are ignored" do
    with_env("DOWNLOAD_MAC_URL" => "javascript:alert(1)", "DOWNLOAD_WINDOWS_URL" => "http://insecure.example.com/x.exe") do
      get billie_download_path, params: {locale: "en"}
      assert_select ".bw-download-card a", count: 0
      assert_no_match(/javascript:alert|insecure\.example/, response.body)
    end
  end

  test "the section is translated in every language" do
    with_env(NO_LINKS) do
      %w[en zh-CN zh-TW ja ko es].each do |locale|
        get billie_download_path, params: {locale: locale}
        assert_select ".bw-download-card", count: 4
        assert_no_match(/translation_missing|Translation missing/, response.body)
      end
    end
  end
end
