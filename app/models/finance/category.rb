module Finance
  # One category a person owns (docs/architecture/category-hierarchy.md). Categories nest without
  # limit; the name is the identity (unique per person ignoring letter case, at every depth), and
  # transactions, rules, budgets and receipts store it as text, so renaming rewrites those rows.
  # Defaults carry a stable `system_key`. The kind (income / expense / transfer) belongs to the root
  # and every descendant shares it. "Uncategorized" is a fixed placeholder and never a row.
  # "Transfers" (system_key "transfers") can be renamed, reordered and given subcategories, but it
  # stays a root and cannot be deleted or merged away.
  #
  # Every read goes through Finance::CategoryTree (or the class helpers below), which call
  # `ensure_seeded!` first: a person without users.finance_categories_seeded_at gets the defaults.
  class Category < ActiveRecord::Base
    self.table_name = "finance_categories"

    class Invalid < StandardError
      attr_reader :code

      def initialize(code)
        @code = code.to_s
        super(@code)
      end
    end

    MAX_PER_USER = 500 # defaults included; same as packages/finance-core
    MAX_LENGTH = 40
    UNCATEGORIZED = DefaultCategories::UNCATEGORIZED
    KINDS = %w[income expense transfer].freeze
    CREATABLE_ROOT_KINDS = %w[income expense].freeze
    PATH_SEPARATOR = " › "

    belongs_to :user
    belongs_to :parent, class_name: "Finance::Category", optional: true
    has_many :children, class_name: "Finance::Category", foreign_key: :parent_id, inverse_of: :parent

    normalizes :name, with: ->(name) { normalize_name(name) }

    validates :name, presence: true, length: {maximum: MAX_LENGTH}
    validates :category_kind, inclusion: {in: KINDS}
    validate :name_is_not_reserved
    validate :name_is_unique_for_user
    validate :parent_is_allowed
    validate :within_limit, on: :create

    # Collapses whitespace and drops control characters. Same rule as normalizeCategoryName in
    # packages/finance-core, so a name means the same thing on the website and in the apps.
    def self.normalize_name(name)
      name.to_s.gsub(/[\u0000-\u001f\u007f]/, "").gsub(/\s+/, " ").strip
    end

    def self.user_id_of(user) = user.is_a?(User) ? user.id : user.to_i

    # ---------- seeding ----------

    # Creates the default taxonomy the first time a person's categories are read. Existing accounts
    # were marked seeded by the migration that materialized their old categories, so they never get
    # it; a person who deletes every category is not seeded again.
    def self.ensure_seeded!(user)
      return if user.is_a?(User) && user.finance_categories_seeded_at
      user_id = user_id_of(user)
      return if user_id.zero?
      unless User.where(id: user_id, finance_categories_seeded_at: nil).exists?
        remember_seeded(user, Time.current) if user.is_a?(User)
        return
      end
      seeded_at = Time.current
      locked = User.find(user_id)
      locked.with_lock do
        next if locked.finance_categories_seeded_at
        add_defaults!(user_id) unless where(user_id: user_id).exists?
        locked.update_columns(finance_categories_seeded_at: seeded_at)
      end
      remember_seeded(user, seeded_at) if user.is_a?(User)
    end

    # Notes the seeding on an in-memory user without leaving it with unsaved changes (it may be locked later).
    def self.remember_seeded(user, value)
      user.finance_categories_seeded_at = value
      user.clear_attribute_changes([:finance_categories_seeded_at])
    end

    # "Add suggested categories": adds the defaults this person doesn't have yet, matched by
    # system_key first and then by name ignoring case. Never renames, moves or duplicates anything.
    # A child whose parent is missing goes under the existing category with the parent's key or
    # name, or the parent is added too. Returns the names added.
    def self.add_suggested!(user)
      ensure_seeded!(user)
      user_id = user_id_of(user)
      User.find(user_id).with_lock { add_defaults!(user_id) }
    end

    def self.add_defaults!(user_id)
      now = Time.current
      rows = where(user_id: user_id).pluck(:id, :name, :system_key, :category_kind, :parent_id, :sort_order)
      next_sort = Hash.new(0)
      rows.each { |row| next_sort[row[4]] = [next_sort[row[4]], row[5] + 1].max }
      by_key = rows.select { |row| row[2] }.to_h { |row| [row[2], row] }
      by_name = rows.to_h { |row| [row[1].downcase, row] }
      count = rows.length
      added = []
      matched = {}
      DefaultCategories::ALL.each do |entry|
        existing = by_key[entry.key] || by_name[entry.name.downcase]
        if existing
          # A same-named category without a key adopts the default's key (nothing visible changes),
          # so automatic categorization can find it.
          if existing[2].nil? && !by_key.key?(entry.key)
            where(id: existing[0]).update_all(system_key: entry.key, updated_at: now)
            existing[2] = entry.key
            by_key[entry.key] = existing
          end
          matched[entry.key] = existing
          next
        end
        break if count >= MAX_PER_USER
        parent = entry.parent_key && matched[entry.parent_key]
        next if entry.parent_key && parent.nil?
        kind = parent ? parent[3] : entry.kind
        sort = next_sort[parent&.first]
        next_sort[parent&.first] = sort + 1
        # A default whose key someone else in this account already holds is added without the key.
        key = by_key.key?(entry.key) ? nil : entry.key
        id = insert!({user_id: user_id, name: entry.name, parent_id: parent&.first, system_key: key, category_kind: kind, sort_order: sort,
                      hidden: false, expanded: false, created_at: now, updated_at: now}, returning: :id).rows.first.first
        row = [id, entry.name, key, kind, parent&.first, sort]
        matched[entry.key] = row
        by_key[key] = row if key
        by_name[entry.name.downcase] = row
        count += 1
        added << entry.name
      end
      Profile.where(user_id: user_id).touch_all if added.any?
      added
    end
    private_class_method :add_defaults!

    # ---------- reading ----------

    # This person's rows, after making sure the tree exists.
    def self.for_user(user)
      ensure_seeded!(user)
      where(user_id: user_id_of(user))
    end

    # Category names in tree order, then Uncategorized.
    def self.names_for(user) = CategoryTree.new(user).names

    def self.valid_for?(user, name)
      return true if name == UNCATEGORIZED
      name.present? && for_user(user).where(name: name).exists?
    end

    # The stored name for a category typed in any letter case (CSV imports), or nil.
    def self.lookup(user, name)
      clean = normalize_name(name)
      return nil if clean.empty?
      return UNCATEGORIZED if clean.casecmp?(UNCATEGORIZED)
      for_user(user).where("lower(name) = lower(?)", clean).pick(:name)
    end

    # The current name of a default by its key. When the person deleted it, falls back to its
    # parent's key ("food.groceries" -> "food") and then to Uncategorized.
    def self.name_for_key(user, key)
      names = for_user(user).where.not(system_key: nil).pluck(:system_key, :name).to_h
      resolve_key(names, key)
    end

    def self.resolve_key(names_by_key, key)
      cursor = key.to_s
      while cursor.present?
        return names_by_key[cursor] if names_by_key[cursor]
        cursor = DefaultCategories.parent_key(cursor) || cursor.rpartition(".").first.presence
      end
      UNCATEGORIZED
    end

    # "income", "expense", "transfer", "any" for Uncategorized, nil for an unknown name.
    def self.kind_of(user, name)
      return "any" if name == UNCATEGORIZED
      for_user(user).where("lower(name) = lower(?)", name.to_s).pick(:category_kind)
    end

    def self.income?(user, name) = kind_of(user, name) == "income"

    def self.transfer?(user, name) = kind_of(user, name) == "transfer"

    # The names of a category and all its descendants (the category's roll-up). Empty when unknown;
    # Uncategorized covers only itself.
    def self.subtree_names(user, name)
      return [UNCATEGORIZED] if name == UNCATEGORIZED
      ensure_seeded!(user)
      connection.select_values(sanitize_sql_array([<<~SQL, user_id_of(user), name.to_s]))
        WITH RECURSIVE subtree(id, name) AS (
          SELECT id, name FROM finance_categories WHERE user_id = ? AND lower(name) = lower(?)
          UNION ALL
          SELECT c.id, c.name FROM finance_categories c JOIN subtree s ON c.parent_id = s.id
        )
        SELECT name FROM subtree
      SQL
    end

    # Whether `name` is the category with this system key or one of its descendants.
    def self.in_key_subtree?(user, name, key)
      return false if name.blank? || name == UNCATEGORIZED
      root = for_user(user).find_by(system_key: key)
      root ? subtree_names(user, root.name).include?(name) : false
    end

    # For an app uploading a statement: returns the category to store, creating it the first time a
    # name the cloud does not know arrives (under `parent` when that is a known category). Falls back
    # to Uncategorized when the name is unusable or the limit is reached.
    def self.ensure_for!(user, name, parent: nil, kind: nil)
      existing = lookup(user, name)
      return existing if existing
      user_id = user_id_of(user)
      parent_row = parent.present? ? for_user(user).where("lower(name) = lower(?)", normalize_name(parent)).first : nil
      root_kind = CREATABLE_ROOT_KINDS.include?(kind.to_s) ? kind.to_s : "expense"
      record = new(user_id: user_id, name: name, parent: parent_row, category_kind: parent_row&.category_kind || root_kind,
        sort_order: next_sort_order(user_id, parent_row&.id))
      if record.save
        Profile.where(user_id: user_id).touch_all
        record.name
      else
        UNCATEGORIZED
      end
    rescue ActiveRecord::RecordNotUnique
      lookup(user, name) || UNCATEGORIZED
    end

    def self.next_sort_order(user_id, parent_id)
      max = where(user_id: user_id, parent_id: parent_id).maximum(:sort_order)
      max ? max + 1 : 0
    end

    # Creates a category for a person (website, commands). Raises ActiveRecord::RecordInvalid.
    def self.create_for!(user, name:, parent: nil, kind: nil)
      ensure_seeded!(user)
      user_id = user_id_of(user)
      parent_row = if parent.is_a?(Category)
        parent
      else
        (parent.present? ? where(user_id: user_id).where("lower(name) = lower(?)", parent.to_s).first : nil)
      end
      record = new(user_id: user_id, name: name, parent: parent_row, category_kind: parent_row&.category_kind || (CREATABLE_ROOT_KINDS.include?(kind.to_s) ? kind.to_s : "expense"),
        sort_order: next_sort_order(user_id, parent_row&.id))
      if parent.present? && parent_row.nil?
        record.errors.add(:parent, :invalid)
        raise ActiveRecord::RecordInvalid, record
      end
      record.save!
      Profile.where(user_id: user_id).touch_all
      record
    end

    # Deletes every category of one person (account data deletion): children before parents.
    def self.delete_all_for(user_id)
      where(user_id: user_id).update_all(parent_id: nil)
      where(user_id: user_id).delete_all
    end

    # ---------- one category ----------

    def transfers_root? = system_key == DefaultCategories::TRANSFERS_KEY

    def root? = parent_id.nil?

    # Ids of this category's descendants (not itself).
    def descendant_ids
      self.class.connection.select_values(self.class.sanitize_sql_array([<<~SQL, id])).map(&:to_i)
        WITH RECURSIVE subtree(id) AS (
          SELECT id FROM finance_categories WHERE parent_id = ?
          UNION ALL
          SELECT c.id FROM finance_categories c JOIN subtree s ON c.parent_id = s.id
        )
        SELECT id FROM subtree
      SQL
    end

    def subtree_names
      self.class.where(id: [id, *descendant_ids]).pluck(:name)
    end

    # Renames the category everywhere it is used. Returns false (with errors) when the new name is not allowed.
    def rename!(new_name)
      old_name = name
      transaction do
        self.name = new_name
        return false unless save
        next if old_name == name
        self.class.rewrite_name!(user_id, old_name, name)
      end
      true
    rescue ActiveRecord::RecordNotUnique
      errors.add(:name, :taken)
      false
    end

    # Rewrites a category name in every place that stores it as text.
    def self.rewrite_name!(user_id, old_name, new_name)
      now = Time.current
      Transaction.where(user_id: user_id, category: old_name).update_all(category: new_name, updated_at: now)
      MerchantRule.where(user_id: user_id, category: old_name).update_all(category: new_name, updated_at: now)
      Budget.where(user_id: user_id, category: old_name).update_all(category: new_name, updated_at: now)
      Receipt.where(user_id: user_id, category: old_name).update_all(category: new_name, updated_at: now)
      RecurringRule.where(user_id: user_id).where("template->>'category' = ?", old_name)
        .update_all(["template = jsonb_set(template, '{category}', to_jsonb(?::text)), updated_at = ?", new_name, now])
      CategoryProposal.where(user_id: user_id, parent_name: old_name).update_all(parent_name: new_name, updated_at: now)
      Profile.where(user_id: user_id).touch_all
    end

    # Moves the category (with its subtree) under `new_parent` (a Category or nil for a root). The
    # subtree takes the new root's kind; entries in it follow (Transaction.sync_kinds_for_category!).
    def move_to!(new_parent)
      raise Invalid, :protected if transfers_root? && new_parent
      raise Invalid, :category_cycle if new_parent && (new_parent.id == id || descendant_ids.include?(new_parent.id))
      raise Invalid, :parent_invalid if new_parent && new_parent.user_id != user_id
      transaction do
        old_kind = category_kind
        self.parent = new_parent
        self.sort_order = self.class.next_sort_order(user_id, new_parent&.id) if parent_id_changed?
        self.category_kind = new_parent.category_kind if new_parent
        save!
        apply_kind_to_subtree!(old_kind)
      end
      self
    end

    # Changes a root's kind (income or expense) and its whole subtree's.
    def change_kind!(kind)
      raise Invalid, :parent_invalid unless root? && !transfers_root? && CREATABLE_ROOT_KINDS.include?(kind.to_s)
      transaction do
        old_kind = category_kind
        update!(category_kind: kind.to_s)
        apply_kind_to_subtree!(old_kind)
      end
      self
    end

    # Swaps this category with its previous (-1) or next (+1) sibling.
    def reorder!(direction)
      transaction do
        siblings = self.class.where(user_id: user_id, parent_id: parent_id).order(:sort_order, Arel.sql("lower(name)")).lock.to_a
        index = siblings.index { |sibling| sibling.id == id }
        other = index && index + direction.to_i.clamp(-1, 1)
        if other && other >= 0 && other < siblings.length && other != index
          siblings[index], siblings[other] = siblings[other], siblings[index]
        end
        siblings.each_with_index { |sibling, position| sibling.update_columns(sort_order: position, updated_at: Time.current) if sibling.sort_order != position }
        Profile.where(user_id: user_id).touch_all
      end
      reload
    end

    # Deletes the category. Its entries move to `move_to` (default: its parent, or Uncategorized for a
    # root); its remembered rules move there too, or are forgotten when that is Uncategorized. Its
    # children move up to its parent, keeping their order. Budgets move to the destination unless the
    # destination already has one for the same period (then they are removed).
    # Returns how many entries moved.
    def remove!(move_to: nil, children_to: :parent)
      raise Invalid, :protected if transfers_root?
      target = move_to.presence || parent&.name || UNCATEGORIZED
      target_row = (target == UNCATEGORIZED) ? nil : self.class.where(user_id: user_id).where("lower(name) = lower(?)", target).first
      raise Invalid, :category_unknown if target != UNCATEGORIZED && target_row.nil?
      raise Invalid, :category_unknown if target_row&.id == id
      target = target_row&.name || UNCATEGORIZED
      transaction do
        now = Time.current
        scope = Transaction.where(user_id: user_id, category: name)
        Transaction.sync_kinds_for_category!(scope, target, user_id) unless target == UNCATEGORIZED
        moved = scope.update_all(category: target, updated_at: now)
        rules = MerchantRule.where(user_id: user_id, category: name)
        if target == UNCATEGORIZED
          rules.delete_all
        else
          rules.find_each { |rule| MerchantRule.where(user_id: user_id, merchant_key: rule.merchant_key, income: rule.income).where.not(id: rule.id).exists? ? rule.destroy! : rule.update_columns(category: target, updated_at: now) }
        end
        Budget.where(user_id: user_id, category: name).find_each do |budget|
          if target == UNCATEGORIZED || Budget.where(user_id: user_id, category: target, period: budget.period).exists?
            budget.destroy!
          else
            budget.update_columns(category: target, updated_at: now)
          end
        end
        Receipt.where(user_id: user_id, category: name).update_all(category: (target == UNCATEGORIZED) ? nil : target, updated_at: now)
        RecurringRule.where(user_id: user_id).where("template->>'category' = ?", name)
          .update_all(["template = jsonb_set(template, '{category}', to_jsonb(?::text)), updated_at = ?", target, now])
        CategoryProposal.where(user_id: user_id, parent_name: name, status: "pending").update_all(status: "dismissed", updated_at: now)
        new_parent = (children_to == :target) ? target_row : parent
        reparent_children!(new_parent, now)
        destroy!
        Profile.where(user_id: user_id).touch_all
        moved
      end
    end

    # Merges this category into `target` (a Category): like delete with that destination, and this
    # category's children become the target's children. Merging into a descendant is rejected.
    def merge_into!(target)
      raise Invalid, :protected if transfers_root?
      raise Invalid, :category_unknown if target.nil? || target.id == id || target.user_id != user_id
      raise Invalid, :category_cycle if descendant_ids.include?(target.id)
      remove!(move_to: target.name, children_to: :target)
    end

    # [name, name, ...] from the root down to this category.
    def path_names
      names = [name]
      cursor = parent
      seen = [id]
      while cursor && !seen.include?(cursor.id)
        names.unshift(cursor.name)
        seen << cursor.id
        cursor = cursor.parent
      end
      names
    end

    private

    # Children move up (keeping their order) after the destination's existing children.
    def reparent_children!(new_parent, now)
      kids = children.order(:sort_order, Arel.sql("lower(name)")).to_a
      return if kids.empty?
      start = self.class.where(user_id: user_id, parent_id: new_parent&.id).where.not(id: id).maximum(:sort_order)
      start = start ? start + 1 : 0
      kind = new_parent ? new_parent.category_kind : category_kind
      kids.each_with_index do |kid, index|
        old_kind = kid.category_kind
        kid.update_columns(parent_id: new_parent&.id, sort_order: start + index, category_kind: kind, updated_at: now)
        kid.send(:apply_kind_to_subtree!, old_kind)
      end
    end

    # After this category's kind changed: its descendants take it, and their entries follow.
    def apply_kind_to_subtree!(old_kind)
      return if old_kind == category_kind
      ids = descendant_ids
      self.class.where(id: ids).update_all(category_kind: category_kind, updated_at: Time.current) if ids.any?
      self.class.where(id: [id, *ids]).pluck(:name).each do |member|
        Transaction.sync_kinds_for_category!(Transaction.where(user_id: user_id, category: member), member, user_id)
      end
      Profile.where(user_id: user_id).touch_all
    end

    def name_is_not_reserved
      errors.add(:name, :reserved, message: "is reserved") if name.to_s.casecmp?(UNCATEGORIZED)
    end

    def name_is_unique_for_user
      return if name.blank? || user_id.nil?
      scope = self.class.where(user_id: user_id).where("lower(name) = lower(?)", name)
      scope = scope.where.not(id: id) if persisted?
      errors.add(:name, :taken) if scope.exists?
    end

    def parent_is_allowed
      return if parent_id.nil? && parent.nil?
      if parent.nil? || parent.user_id != user_id
        errors.add(:parent, :invalid)
      elsif transfers_root?
        errors.add(:parent, :protected, message: "is not allowed for Transfers")
      elsif persisted? && (parent.id == id || descendant_ids.include?(parent.id))
        errors.add(:parent, :category_cycle, message: "would contain itself")
      elsif parent.category_kind != category_kind
        errors.add(:category_kind, :inclusion)
      end
    end

    def within_limit
      return if user_id.nil?
      errors.add(:base, :too_many, count: MAX_PER_USER, message: "too many categories") if self.class.where(user_id: user_id).count >= MAX_PER_USER
    end
  end
end
