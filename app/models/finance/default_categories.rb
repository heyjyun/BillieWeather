require "json"

module Finance
  # The default category taxonomy (docs/architecture/category-hierarchy.md), read from
  # packages/finance-core/schema/default-categories.json, the same file the TypeScript clients
  # import. New people get it the first time their categories are read (Finance::Category.ensure_seeded!).
  # Keys never change; names and labels may. `legacy` marks the nine pre-2026-11 built-ins.
  module DefaultCategories
    PATH = Rails.root.join("packages/finance-core/schema/default-categories.json")
    SCHEMA = JSON.parse(File.read(PATH)).freeze

    UNCATEGORIZED = SCHEMA.dig("uncategorized", "name").freeze
    UNCATEGORIZED_LABELS = SCHEMA.dig("uncategorized", "labels").freeze

    Entry = Data.define(:key, :name, :kind, :parent_key, :labels, :legacy, :deletable, :sort_order)

    # Every default, parents before children, in the file's order.
    ALL = SCHEMA.fetch("categories").each_with_index.flat_map do |root, root_index|
      parent = Entry.new(key: root.fetch("key"), name: root.fetch("name"), kind: root.fetch("kind"), parent_key: nil,
        labels: root.fetch("labels", {}).freeze, legacy: root["legacy"] == true, deletable: root["deletable"] != false, sort_order: root_index)
      children = root.fetch("children", []).each_with_index.map do |child, child_index|
        Entry.new(key: child.fetch("key"), name: child.fetch("name"), kind: parent.kind, parent_key: parent.key,
          labels: child.fetch("labels", {}).freeze, legacy: child["legacy"] == true, deletable: child["deletable"] != false, sort_order: child_index)
      end
      [parent, *children]
    end.freeze
    BY_KEY = ALL.index_by(&:key).freeze
    BY_NAME = ALL.index_by { |entry| entry.name.downcase }.freeze
    ROOTS = ALL.select { |entry| entry.parent_key.nil? }.freeze
    LEGACY = ALL.select(&:legacy).freeze
    # The ten names that were built in before 2026-11 (nine categories plus the Uncategorized placeholder).
    LEGACY_NAMES = (LEGACY.map(&:name) + [UNCATEGORIZED]).freeze
    TRANSFERS_KEY = "transfers"
    INCOME_KEY = "income"
    BUSINESS_KEY = "business"

    module_function

    def entry(key) = BY_KEY[key.to_s]

    # The parent key of a default key ("food.groceries" -> "food"), or nil for a root.
    def parent_key(key) = BY_KEY[key.to_s]&.parent_key

    # The label shown for a category name: the default's translation when the name is still a
    # default's English name (not renamed), Uncategorized's translation, otherwise the name itself.
    def label(name, locale = I18n.locale)
      text = name.to_s
      locale = locale.to_s
      return text if locale == "en" || locale.start_with?("en-")
      labels = if text == UNCATEGORIZED then UNCATEGORIZED_LABELS
      else BY_NAME[text.downcase]&.then { |entry| (entry.name == text) ? entry.labels : nil }
      end
      return text unless labels
      labels[locale] || labels[locale.split("-").first] || text
    end

    # Every way a default's name may be written in the supported languages (for typed commands).
    def names_in_all_locales(name)
      entry = (name == UNCATEGORIZED) ? nil : BY_NAME[name.to_s.downcase]
      labels = (name == UNCATEGORIZED) ? UNCATEGORIZED_LABELS : (entry && entry.name == name ? entry.labels : {})
      ([name] + labels.values).uniq
    end
  end
end
