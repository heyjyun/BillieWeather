module Finance
  # Per-person presentation of a category: parent (two levels at most), income or expense tree,
  # order and hidden flag. Categories themselves stay names (built-ins + Finance::CustomCategory).
  class CategorySetting < ActiveRecord::Base
    self.table_name = "finance_category_settings"

    belongs_to :user
    validates :name, presence: true, length: {maximum: 40}
    validates :category_kind, inclusion: {in: Domain::CATEGORY_KINDS}
    validate :two_levels_at_most

    def self.for(user)
      where(user_id: user.id).index_by { |setting| setting.name.downcase }
    end

    private

    def two_levels_at_most
      return if parent_name.blank?
      errors.add(:parent_name, :invalid) if parent_name.casecmp?(name)
      parent = self.class.where(user_id: user_id).where("lower(name) = ?", parent_name.downcase).first
      errors.add(:parent_name, :too_deep) if parent&.parent_name.present?
      if self.class.where(user_id: user_id).where("lower(parent_name) = ?", name.downcase).where.not(id: id).exists?
        errors.add(:parent_name, :too_deep)
      end
    end
  end
end
