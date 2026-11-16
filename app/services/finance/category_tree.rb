module Finance
  # Categories as the person arranges them: two levels at most, an income tree and an expense tree,
  # an order and a hidden flag (Finance::CategorySetting). Built-in names stay fixed; "Transfers" and
  # "Uncategorized" belong to no tree. Hidden categories stay on existing entries but leave the pickers.
  class CategoryTree
    Node = Data.define(:name, :kind, :parent, :hidden, :custom, :sort_order, :children)
    SPECIAL = %w[Transfers Uncategorized].freeze

    def initialize(user)
      @user = user
      @settings = CategorySetting.for(user)
      @custom = CustomCategory.where(user_id: user.id).pluck(:name)
    end

    def names
      Transaction::CATEGORIES + @custom
    end

    def kind_of(name)
      return "income" if name == "Income"
      return "transfer" if name == "Transfers"
      return "any" if name == "Uncategorized"
      return "expense" if Transaction::CATEGORIES.include?(name)
      setting(name)&.category_kind || "expense"
    end

    def parent_of(name)
      parent = setting(name)&.parent_name
      parent if parent.present? && names.any? { |candidate| candidate.casecmp?(parent) }
    end

    def hidden?(name)
      !!setting(name)&.hidden
    end

    # Top-level nodes of one tree ("expense" or "income"), each with its children, in order.
    def roots(kind)
      nodes = (names - SPECIAL).select { |name| kind_of(name) == kind }.map { |name| node(name) }
      children = nodes.group_by { |n| n.parent&.downcase }
      nodes.select { |n| n.parent.nil? || nodes.none? { |p| p.name.casecmp?(n.parent) } }
        .sort_by { |n| [n.sort_order, n.custom ? 1 : 0, n.name.downcase] }
        .map { |n| n.with(children: (children[n.name.downcase] || []).sort_by { |c| [c.sort_order, c.name.downcase] }) }
    end

    # [[label, name]] for a select: parents then indented children; hidden ones only when `include` it.
    def options(kind, include: nil, label: ->(name) { name })
      result = roots(kind).flat_map do |root|
        [root, *root.children].filter_map do |n|
          next if n.hidden && n.name != include
          [(n.parent ? "— " : "") + label.call(n.name).to_s, n.name]
        end
      end
      result << [label.call("Uncategorized").to_s, "Uncategorized"]
      result
    end

    # The names a budget or report on `name` covers (itself and its children).
    def with_children(name)
      [name] + names.select { |candidate| parent_of(candidate)&.casecmp?(name) }
    end

    private

    def setting(name)
      @settings[name.to_s.downcase]
    end

    def node(name)
      s = setting(name)
      Node.new(name: name, kind: kind_of(name), parent: parent_of(name), hidden: !!s&.hidden, custom: @custom.include?(name),
        sort_order: s&.sort_order || 0, children: [])
    end
  end
end
