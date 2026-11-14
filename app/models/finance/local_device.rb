module Finance
  # One app installation of one account: the website's "Local database" card. Unique per
  # (user_id, device_id). The device id is a random UUID the app keeps in a file next to its
  # SQLite databases (never a hardware id, a name, a size, a launch time or a session).
  # The website only displays this; it never controls the device.
  class LocalDevice < ActiveRecord::Base
    self.table_name = "finance_local_devices"

    UUID = /\A[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\z/
    PLATFORMS = %w[macos windows linux ios android].freeze

    belongs_to :user
    has_many :reports, ->(device) { where(user_id: device.user_id) }, class_name: "Finance::LocalDatabaseReport",
      foreign_key: :device_id, primary_key: :device_id, inverse_of: false

    validates :device_id, format: {with: UUID}, uniqueness: {scope: :user_id}
    validates :name, length: {maximum: 80}
    validates :label, length: {maximum: 80}
    validates :platform, inclusion: {in: PLATFORMS}, allow_nil: true

    before_validation { self.label = label.to_s.gsub(/[[:cntrl:]]/, "").squish.presence }

    # Reported with the stable, file-based identity (current apps). Legacy devices never were.
    def verified? = platform.present?

    def display_name = label.presence || name.presence

    def self.platform_label(platform)
      {"macos" => "macOS", "windows" => "Windows", "linux" => "Linux", "ios" => "iOS", "android" => "Android"}[platform]
    end
  end
end
