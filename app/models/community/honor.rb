module Community
  # An honorary badge granted by an admin. Badges stack: one person can hold
  # Founding Member and Founding Patron at the same time. They grant no permissions.
  class Honor < ActiveRecord::Base
    self.table_name = "community_honors"

    KINDS = %w[founding_member founding_patron].freeze
    # How a Founding Patron's transfer was received; "other" covers anything outside the four QR codes.
    RECORDED_PAYMENT_METHODS = (Community::PAYMENT_METHODS + %w[other]).freeze

    belongs_to :user
    belongs_to :granted_by, class_name: "User", optional: true
    belongs_to :revoked_by, class_name: "User", optional: true

    scope :active, -> { where(revoked_at: nil) }
    scope :patrons, -> { where(kind: "founding_patron") }

    before_validation :normalize

    validates :kind, inclusion: {in: KINDS}
    validates :granted_at, presence: true
    validates :payment_method, inclusion: {in: RECORDED_PAYMENT_METHODS}, allow_nil: true
    validates :note, length: {maximum: 1000}
    validates :revoke_reason, length: {maximum: 500}
    validate :patron_transfer_confirmed, if: :founding_patron?
    validate :one_active_badge_per_kind, if: -> { active? && (new_record? || will_save_change_to_revoked_at?) }

    def self.grant!(user:, kind:, by:, **attributes)
      create!(user: user, kind: kind, granted_by: by, **attributes)
    rescue ActiveRecord::RecordNotUnique
      # Two admins granting at the same moment: the partial unique index is the final word.
      honor = new(user: user, kind: kind)
      honor.errors.add(:base, I18n.t("billie.community.admin.duplicate_badge"))
      raise ActiveRecord::RecordInvalid, honor
    end

    def active?
      revoked_at.nil?
    end

    def founding_patron?
      kind == "founding_patron"
    end

    def revoke!(by:, reason: nil)
      update!(revoked_at: Time.current, revoked_by: by, revoke_reason: reason)
    end

    private

    def normalize
      self.granted_at ||= Time.current
      self.payment_method = payment_method.presence
      self.note = note.to_s.strip.presence
      self.revoke_reason = revoke_reason.to_s.strip.presence
    end

    def one_active_badge_per_kind
      scope = self.class.active.where(user_id: user_id, kind: kind)
      scope = scope.where.not(id: id) if persisted?
      errors.add(:base, I18n.t("billie.community.admin.duplicate_badge")) if scope.exists?
    end

    def patron_transfer_confirmed
      errors.add(:base, I18n.t("billie.community.admin.patron_requires_confirmation")) if confirmed_at.blank? || payment_method.blank?
    end
  end
end
