module Finance
  # An app installation that reports basic facts about its local databases (see
  # LocalDatabaseReport). The website only displays this; it never controls the device.
  class LocalDevice < ActiveRecord::Base
    self.table_name = "finance_local_devices"

    UUID = /\A[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\z/

    belongs_to :user

    validates :device_id, format: {with: UUID}, uniqueness: {scope: :user_id}
    validates :name, length: {maximum: 80}
  end
end
