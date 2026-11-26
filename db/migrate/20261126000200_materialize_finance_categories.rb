# Materializes every existing person's categories into finance_categories exactly as they had them
# (docs/architecture/category-hierarchy.md, Storage): the nine old built-ins with their legacy keys,
# their own categories, and their old parent, kind, order and hidden settings. Nothing is added from
# the new default taxonomy (people can opt in with "Add suggested categories"). Parents are inserted
# before children; a child whose old parent is missing (or of another kind) becomes a root.
# Sets users.finance_categories_seeded_at for everyone so nobody is seeded with the defaults later.
class MaterializeFinanceCategories < ActiveRecord::Migration[8.1]
  LEGACY = [
    ["Income", "income", "income"], ["Housing", "housing", "expense"], ["Food & dining", "food", "expense"],
    ["Transport", "transport", "expense"], ["Utilities", "utilities", "expense"], ["Shopping", "shopping", "expense"],
    ["Health", "health", "expense"], ["Business", "business", "expense"], ["Transfers", "transfers", "transfer"]
  ].freeze
  SPECIAL = %w[transfers uncategorized].freeze

  def up
    now = Time.current
    select_values("SELECT id FROM users ORDER BY id").each do |user_id|
      materialize(user_id.to_i, now)
    end
    execute("UPDATE users SET finance_categories_seeded_at = #{quote(now)} WHERE finance_categories_seeded_at IS NULL")
  end

  def down
    execute("UPDATE finance_categories SET parent_id = NULL")
    execute("DELETE FROM finance_categories")
    execute("UPDATE users SET finance_categories_seeded_at = NULL")
  end

  private

  def quote(value) = connection.quote(value)

  def select_values(sql) = connection.select_values(sql)

  def select_value(sql) = connection.select_value(sql)

  def materialize(user_id, now)
    return if select_value("SELECT 1 FROM finance_categories WHERE user_id = #{user_id} LIMIT 1")
    settings = connection.select_rows("SELECT name, parent_name, category_kind, sort_order, hidden FROM finance_category_settings WHERE user_id = #{user_id}")
      .to_h { |name, parent, kind, sort, hidden| [name.downcase, {parent: parent, kind: kind, sort: sort.to_i, hidden: hidden == true || hidden == "t"}] }
    nodes = {}
    LEGACY.each do |name, key, kind|
      setting = settings[name.downcase]
      nodes[name.downcase] = {name: name, key: key, kind: kind, custom: false, parent: nil, sort: setting&.dig(:sort) || 0, hidden: !!setting&.dig(:hidden)}
    end
    select_values("SELECT name FROM finance_custom_categories WHERE user_id = #{user_id} ORDER BY lower(name), id").each do |name|
      next if nodes.key?(name.downcase) || name.casecmp?("Uncategorized")
      setting = settings[name.downcase]
      kind = %w[income expense].include?(setting&.dig(:kind)) ? setting[:kind] : "expense"
      nodes[name.downcase] = {name: name, key: nil, kind: kind, custom: true, parent: setting&.dig(:parent).presence&.downcase,
                              sort: setting&.dig(:sort) || 0, hidden: !!setting&.dig(:hidden)}
    end
    # Only a custom category had a parent; it must exist, have the same kind and not be special.
    nodes.each_value do |node|
      parent = node[:parent] && nodes[node[:parent]]
      node[:parent] = nil unless parent && parent[:kind] == node[:kind] && !SPECIAL.include?(node[:parent]) && node[:parent] != node[:name].downcase
    end
    # Break any cycle (never expected; the old rules allowed two levels only).
    nodes.each_value do |node|
      seen = [node[:name].downcase]
      cursor = node[:parent]
      while cursor
        if seen.include?(cursor)
          node[:parent] = nil
          break
        end
        seen << cursor
        cursor = nodes[cursor][:parent]
      end
    end
    ids = {}
    insert_level = lambda do |parent_key|
      siblings = nodes.values.select { |node| node[:parent] == parent_key }
        .sort_by { |node| [node[:sort], node[:custom] ? 1 : 0, node[:name].downcase] }
      siblings.each_with_index do |node, index|
        parent_id = parent_key ? ids.fetch(parent_key) : nil
        ids[node[:name].downcase] = select_value(<<~SQL).to_i
          INSERT INTO finance_categories (user_id, name, parent_id, system_key, category_kind, sort_order, hidden, expanded, created_at, updated_at)
          VALUES (#{user_id}, #{quote(node[:name])}, #{parent_id ? parent_id : "NULL"}, #{quote(node[:key])}, #{quote(node[:kind])}, #{index},
                  #{quote(node[:hidden])}, FALSE, #{quote(now)}, #{quote(now)})
          RETURNING id
        SQL
        insert_level.call(node[:name].downcase)
      end
    end
    insert_level.call(nil)
  end
end
