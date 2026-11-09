module Community
  # An admin's invitation for one signed-in person to see the personal payment QR codes.
  # The codes belong to a private account, so they are never shown to every visitor.
  class SupportAccess < ActiveRecord::Base
    self.table_name = "community_support_accesses"

    belongs_to :user
    belongs_to :granted_by, class_name: "User", optional: true
    belongs_to :revoked_by, class_name: "User", optional: true

    scope :active, -> { where(revoked_at: nil) }

    def self.grant!(user:, by:)
      access = find_or_initialize_by(user: user)
      return access if access.persisted? && access.active?
      access.update!(granted_at: Time.current, granted_by: by, revoked_at: nil, revoked_by: nil)
      access
    end

    def active?
      persisted? && revoked_at.nil?
    end

    def revoke!(by:)
      update!(revoked_at: Time.current, revoked_by: by) if active?
    end
  end
end
