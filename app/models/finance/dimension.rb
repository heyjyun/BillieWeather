module Finance
  # Shared behaviour of the optional dimensions merchant (商家), project (项目) and tag: a named,
  # per-user list that can be renamed, ordered, archived (hidden from pickers, history kept), merged
  # and deleted (entries lose the reference; the change is audited by the controller).
  module Dimension
    extend ActiveSupport::Concern

    included do
      belongs_to :user
      validates :name, presence: true, length: {maximum: 60}, format: {with: /\A[^\p{Cc}]*\z/}
      validate :name_unique_for_user
      before_validation { self.name = name.to_s.squish }
      scope :active, -> { where(archived_at: nil) }
      scope :ordered, -> { order(:sort_order, Arel.sql("lower(name)")) }
    end

    def archived?
      archived_at.present?
    end

    private

    def name_unique_for_user
      return if name.blank?
      clash = self.class.where(user_id: user_id).where("lower(name) = ?", name.downcase)
      clash = clash.where.not(id: id) if persisted?
      errors.add(:name, :taken) if clash.exists?
    end
  end
end
