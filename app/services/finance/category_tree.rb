module Finance
  # A person's categories as one in-memory tree (Finance::Category rows, loaded once), for pages,
  # pickers, roll-ups and key lookups (docs/architecture/category-hierarchy.md). Depth is unlimited;
  # siblings are ordered by sort_order. Uncategorized is the fixed placeholder: it is in `names` and
  # at the end of every picker, but never in the tree. Hidden categories (and their subtrees) stay on
  # existing entries but leave the pickers.
  class CategoryTree
    Node = Data.define(:id, :name, :kind, :key, :parent, :hidden, :expanded, :sort_order, :depth, :children) do
      def custom = key.nil?
    end
    UNCATEGORIZED = Category::UNCATEGORIZED

    attr_reader :user

    def initialize(user)
      @user = user
      Category.ensure_seeded!(user)
      @rows = Category.where(user_id: Category.user_id_of(user)).order(:sort_order, Arel.sql("lower(name)"), :id)
        .pluck(:id, :name, :parent_id, :system_key, :category_kind, :sort_order, :hidden, :expanded)
      build
    end

    # Every category name in tree order (parents before children), then Uncategorized.
    def names
      @names ||= nodes.map(&:name) + [UNCATEGORIZED]
    end

    # Every node, depth first, parents before children.
    def nodes
      @nodes ||= flatten(@roots)
    end

    # Top-level nodes, each with its children (recursively). `kind` limits them to one kind.
    def roots(kind = nil)
      kind ? @roots.select { |node| node.kind == kind } : @roots
    end

    def node(name)
      @by_lower[name.to_s.downcase]
    end

    def include?(name)
      name == UNCATEGORIZED || @by_name.key?(name.to_s)
    end

    # "income", "expense", "transfer"; "any" for Uncategorized; "expense" for an unknown name.
    def kind_of(name)
      return "any" if name == UNCATEGORIZED
      node(name)&.kind || "expense"
    end

    def parent_of(name)
      node(name)&.parent
    end

    def hidden?(name)
      !!node(name)&.hidden
    end

    def key_of(name)
      node(name)&.key
    end

    # The current name of a default key, falling back to its parent key and then to Uncategorized.
    def name_for_key(key)
      Category.resolve_key(@by_key, key)
    end

    # The names a budget, filter or report on `name` covers: itself and all its descendants.
    def subtree(name)
      return [UNCATEGORIZED] if name == UNCATEGORIZED
      start = node(name)
      return [name.to_s].compact_blank unless start
      flatten([start]).map(&:name)
    end
    alias_method :with_children, :subtree

    # Names of `name`'s descendants (not itself).
    def descendants(name)
      subtree(name).drop(1)
    end

    # The root a category belongs to (itself for a root, the name itself when unknown).
    def root_of(name)
      return name if name == UNCATEGORIZED
      current = node(name)
      return name unless current
      seen = Set.new
      while current.parent && !seen.include?(current.name)
        seen << current.name
        current = node(current.parent) || break
      end
      current.name
    end

    # [root, ..., name].
    def path_names(name)
      current = node(name)
      return [name.to_s] unless current
      result = [current.name]
      while current.parent && (current = node(current.parent)) && !result.include?(current.name)
        result.unshift(current.name)
      end
      result
    end

    # "Food & dining › Groceries" (labels translated with `label` when given).
    def path(name, label: nil)
      path_names(name).map { |part| label ? label.call(part).to_s : part }.join(Category::PATH_SEPARATOR)
    end

    def in_key_subtree?(name, key)
      root = @by_key[key.to_s]
      root ? subtree(root).include?(name.to_s) : false
    end

    # Names in the transfer subtree (choosing one makes an entry a transfer).
    def transfer_names
      @transfer_names ||= nodes.select { |n| n.kind == "transfer" }.map(&:name)
    end

    def income_names
      @income_names ||= nodes.select { |n| n.kind == "income" }.map(&:name)
    end

    def business?(name)
      in_key_subtree?(name, DefaultCategories::BUSINESS_KEY)
    end

    # The category a transfer-like entry carries: its own if already in the transfer subtree,
    # otherwise the current name of the Transfers category.
    def transfer_category(current = nil)
      transfer_names.include?(current.to_s) ? current : name_for_key(DefaultCategories::TRANSFERS_KEY)
    end

    # [[label, name]] for a select: every category in tree order, indented by depth, then
    # Uncategorized. `kind` keeps one kind ("expense", "income", "transfer"; nil = all kinds).
    # Hidden ones (and their subtrees) are left out unless one is `include`.
    def options(kind = nil, include: nil, label: ->(name) { name }, exclude: [], include_hidden: false)
      skip = Array(exclude).flat_map { |name| subtree(name) }.to_set
      result = []
      walk = lambda do |list|
        list.each do |n|
          next if skip.include?(n.name) || (n.hidden && !include_hidden && n.name != include)
          result << [("— " * n.depth) + label.call(n.name).to_s, n.name]
          walk.call(n.children)
        end
      end
      walk.call(roots(kind))
      # The current value stays selectable even when it sits under a hidden category.
      if include.present? && @by_name.key?(include.to_s) && result.none? { |_label, value| value == include }
        result << [label.call(include).to_s, include]
      end
      result << [label.call(UNCATEGORIZED).to_s, UNCATEGORIZED]
      result
    end

    # Parents a category could move under: every category except itself, its descendants and the
    # transfer root's restrictions (Transfers itself cannot be nested).
    def parent_options(name, label: ->(n) { n })
      return [] if key_of(name) == DefaultCategories::TRANSFERS_KEY
      blocked = subtree(name).to_set
      nodes.reject { |n| blocked.include?(n.name) }.map { |n| [("— " * n.depth) + label.call(n.name).to_s, n.name] }
    end

    # Defaults this person doesn't have (matched by key, then by name ignoring case): what
    # "Add suggested categories" would add.
    def missing_defaults
      DefaultCategories::ALL.reject { |entry| @by_key.key?(entry.key) || @by_lower.key?(entry.name.downcase) }
    end

    # The sync format's `tree`: every category, parents before children.
    def as_wire
      nodes.map { |n| {name: n.name, parent: n.parent, kind: n.kind, key: n.key, sort_order: n.sort_order, hidden: n.hidden} }
    end

    private

    def build
      by_id = @rows.to_h { |row| [row[0], row] }
      children = @rows.group_by { |row| (row[2] && by_id.key?(row[2])) ? row[2] : nil }
      @by_key = @rows.select { |row| row[3] }.to_h { |row| [row[3], row[1]] }
      visited = Set.new
      make = lambda do |row, depth|
        visited << row[0]
        kids = (children[row[0]] || []).reject { |kid| visited.include?(kid[0]) }.map { |kid| make.call(kid, depth + 1) }
        parent = (row[2] && by_id[row[2]]) ? by_id[row[2]][1] : nil
        Node.new(id: row[0], name: row[1], kind: row[4], key: row[3], parent: parent, hidden: row[6], expanded: row[7],
          sort_order: row[5], depth: depth, children: kids)
      end
      @roots = (children[nil] || []).map { |row| make.call(row, 0) }
      @by_name = {}
      @by_lower = {}
      flatten(@roots).each do |n|
        @by_name[n.name] = n
        @by_lower[n.name.downcase] = n
      end
    end

    def flatten(list)
      list.flat_map { |n| [n, *flatten(n.children)] }
    end
  end
end
