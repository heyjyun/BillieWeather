# Homepage download section. Installers are hosted outside this app (for example a
# GitHub Release); set DOWNLOAD_MAC_URL / DOWNLOAD_WINDOWS_URL to an https link to
# turn a button on. Until then it shows "coming soon" instead of a dead link.
# iOS and Android have no installer yet, so they always show "coming soon".
module DownloadsHelper
  DOWNLOAD_PLATFORMS = [
    {key: "mac", icon: "laptop", env: "DOWNLOAD_MAC_URL"},
    {key: "windows", icon: "monitor", env: "DOWNLOAD_WINDOWS_URL"},
    {key: "ios", icon: "phone", env: nil},
    {key: "android", icon: "phone", env: nil}
  ].freeze

  def billie_download_platforms
    DOWNLOAD_PLATFORMS.map do |platform|
      url = platform[:env] && billie_download_url(ENV[platform[:env]])
      status = url ? :available : :coming_soon
      platform.merge(url: url, status: status)
    end
  end

  private

  def billie_download_url(value)
    uri = URI.parse(value.to_s.strip)
    uri.to_s if uri.is_a?(URI::HTTPS) && uri.host.present?
  rescue URI::InvalidURIError
    nil
  end
end
