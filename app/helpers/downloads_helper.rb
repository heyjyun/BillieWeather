# Homepage download section. Installers are hosted outside this app (for example a
# GitHub Release); set DOWNLOAD_MAC_URL / DOWNLOAD_WINDOWS_URL to an https link to
# turn a button on. Until then it shows "coming soon" instead of a dead link.
# iOS and Android stay disabled while they are in development.
module DownloadsHelper
  DOWNLOAD_PLATFORMS = [
    {key: "mac", icon: "laptop", env: "DOWNLOAD_MAC_URL", status: :desktop},
    {key: "windows", icon: "monitor", env: "DOWNLOAD_WINDOWS_URL", status: :desktop},
    {key: "ios", icon: "phone", env: nil, status: :in_development},
    {key: "android", icon: "phone", env: nil, status: :in_development}
  ].freeze

  def billie_download_platforms
    DOWNLOAD_PLATFORMS.map do |platform|
      url = platform[:env] && billie_download_url(ENV[platform[:env]])
      status = if platform[:status] == :in_development then :in_development
      elsif url then :available
      else :coming_soon
      end
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
