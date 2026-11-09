module Finance
  # A category a person added on top of the built-in list. Transactions and remembered rules
  # store the category name as text, so renaming or deleting one also updates those rows.
  # Categories belong to one account and are never shared.
  class CustomCategory < ActiveRecord::Base
    self.table_name = "finance_custom_categories"

    MAX_PER_USER = 50
    MAX_LENGTH = 40

    belongs_to :user

    normalizes :name, with: ->(name) { normalize_name(name) }

    validates :name, presence: true, length: {maximum: MAX_LENGTH}
    validate :name_is_not_built_in
    validate :name_is_unique_for_user
    validate :within_limit, on: :create

    # Collapses whitespace and drops control characters. Same rule as normalizeCategoryName in
    # packages/finance-core, so a name means the same thing on the website and in the apps.
    def self.normalize_name(name)
      name.to_s.gsub(/[\u0000-\u001f\u007f]/, "").gsub(/\s+/, " ").strip
    end

    # Built-in names first (in their usual order), then this person's own, alphabetically.
    def self.names_for(user)
      Transaction::CATEGORIES + where(user_id: user.id).order(Arel.sql("lower(name)")).pluck(:name)
    end

    def self.valid_for?(user, name)
      Transaction::CATEGORIES.include?(name) || where(user_id: user.id, name: name).exists?
    end

    # The stored name for a category typed in any letter case (CSV imports), or nil.
    def self.lookup(user, name)
      clean = normalize_name(name)
      Transaction::CATEGORIES.find { |candidate| candidate.casecmp?(clean) } ||
        where(user_id: user.id).where("lower(name) = lower(?)", clean).pick(:name)
    end

    # For an app uploading a statement: returns the category to store, creating a custom one the
    # first time a name the cloud does not know arrives. Falls back to Uncategorized when the
    # name is unusable or the limit is reached.
    def self.ensure_for!(user, name)
      return name if Transaction::CATEGORIES.include?(name)
      existing = lookup(user, name)
      return existing if existing
      record = create(user: user, name: name)
      record.persisted? ? record.name : "Uncategorized"
    rescue ActiveRecord::RecordNotUnique
      lookup(user, name) || "Uncategorized"
    end

    # Renames the category everywhere it is used. Returns false (with errors) when the new name is not allowed.
    def rename!(new_name)
      old_name = name
      transaction do
        self.name = new_name
        return false unless save
        next if old_name == name
        now = Time.current
        Transaction.where(user_id: user_id, category: old_name).update_all(category: name, updated_at: now)
        MerchantRule.where(user_id: user_id, category: old_name).update_all(category: name, updated_at: now)
        Profile.where(user_id: user_id).touch_all
      end
      true
    rescue ActiveRecord::RecordNotUnique
      errors.add(:name, :taken)
      false
    end

    # Deletes the category. Its transactions become Uncategorized and its remembered rules are
    # forgotten; nothing else changes. Returns how many transactions moved.
    def remove!
      transaction do
        moved = Transaction.where(user_id: user_id, category: name).update_all(category: "Uncategorized", updated_at: Time.current)
        MerchantRule.where(user_id: user_id, category: name).delete_all
        Profile.where(user_id: user_id).touch_all
        destroy!
        moved
      end
    end

    private

    def name_is_not_built_in
      errors.add(:name, :reserved) if Transaction::CATEGORIES.any? { |built_in| built_in.casecmp?(name.to_s) }
    end

    def name_is_unique_for_user
      return if name.blank? || user_id.nil?
      scope = self.class.where(user_id: user_id).where("lower(name) = lower(?)", name)
      scope = scope.where.not(id: id) if persisted?
      errors.add(:name, :taken) if scope.exists?
    end

    def within_limit
      return if user_id.nil?
      errors.add(:base, :too_many, count: MAX_PER_USER) if self.class.where(user_id: user_id).count >= MAX_PER_USER
    end
  end
end
