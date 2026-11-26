-- Version 11: the category tree (docs/architecture/category-hierarchy.md).
-- Categories nest without a depth limit, each person owns and edits all of them, and defaults carry a
-- stable `system_key`. One `categories` table, keyed by name (unique ignoring letter case); `parent` holds
-- the parent's name. "Uncategorized" is never a row.
--
-- Existing books keep exactly what they had: the nine old built-ins (with their legacy keys, only when the
-- book already holds any transactions, categories, rules or budgets), every custom category, and their old
-- parent, kind, order and hidden settings (category_meta). Nothing from the new taxonomy is added here; the
-- app seeds a book without any of those with the defaults the first time it opens (setting `category_seed`).
-- custom_categories and category_meta are kept unchanged (rollback) and no longer used.
--
-- Rollback: the pre-migration copy (src-tauri/src/snapshot.rs). Older app versions refuse a database of this version.

CREATE TABLE categories (
  name TEXT PRIMARY KEY NOT NULL COLLATE NOCASE CHECK (length(name) BETWEEN 1 AND 40 AND lower(name) <> 'uncategorized'),
  parent TEXT COLLATE NOCASE,
  system_key TEXT,
  kind TEXT NOT NULL DEFAULT 'expense' CHECK (kind IN ('income', 'expense', 'transfer')),
  sort_order INTEGER NOT NULL DEFAULT 0,
  hidden INTEGER NOT NULL DEFAULT 0 CHECK (hidden IN (0, 1)),
  expanded INTEGER NOT NULL DEFAULT 0 CHECK (expanded IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (parent IS NULL OR (parent <> name AND lower(parent) <> 'uncategorized'))
);
CREATE UNIQUE INDEX index_categories_on_system_key ON categories (system_key) WHERE system_key IS NOT NULL;
CREATE INDEX index_categories_on_parent ON categories (parent);

-- The nine old built-ins, in their old order, for a book that is already in use.
WITH legacy (name, system_key, kind, position) AS (VALUES
  ('Income', 'income', 'income', 0), ('Housing', 'housing', 'expense', 1), ('Food & dining', 'food', 'expense', 2),
  ('Transport', 'transport', 'expense', 3), ('Utilities', 'utilities', 'expense', 4), ('Shopping', 'shopping', 'expense', 5),
  ('Health', 'health', 'expense', 6), ('Business', 'business', 'expense', 7), ('Transfers', 'transfers', 'transfer', 8))
INSERT INTO categories (name, parent, system_key, kind, sort_order, hidden, created_at, updated_at)
  SELECT l.name, NULL, l.system_key, l.kind, COALESCE(m.sort_order, 1000 + l.position), COALESCE(m.hidden, 0),
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  FROM legacy l LEFT JOIN category_meta m ON m.name = l.name
  WHERE EXISTS (SELECT 1 FROM transactions) OR EXISTS (SELECT 1 FROM custom_categories) OR EXISTS (SELECT 1 FROM category_meta)
    OR EXISTS (SELECT 1 FROM merchant_rules) OR EXISTS (SELECT 1 FROM budgets)
  ORDER BY l.position;

-- Custom categories with their old settings. The old tree had two levels: a parent counts only when it is a
-- built-in other than Transfers, or a custom category that is itself at the top level. A child has its
-- parent's tree (income or expense); the old default order put custom categories after the built-ins, by name.
WITH legacy (name) AS (VALUES ('Income'), ('Housing'), ('Food & dining'), ('Transport'), ('Utilities'), ('Shopping'), ('Health'), ('Business'), ('Transfers')),
custom AS (SELECT name, created_at, ROW_NUMBER() OVER (ORDER BY name COLLATE NOCASE) - 1 AS position FROM custom_categories),
placed AS (
  SELECT c.name, c.created_at, c.position, m.sort_order, m.hidden, m.category_kind, pl.name AS legacy_parent, pm.category_kind AS parent_kind,
    CASE WHEN m.parent IS NOT NULL AND lower(m.parent) <> lower(c.name)
      AND ((pl.name IS NOT NULL AND pl.name <> 'Transfers') OR (pc.name IS NOT NULL AND pm.parent IS NULL)) THEN COALESCE(pl.name, pc.name) END AS parent
  FROM custom c
  LEFT JOIN category_meta m ON m.name = c.name
  LEFT JOIN legacy pl ON lower(pl.name) = lower(m.parent)
  LEFT JOIN custom_categories pc ON pc.name = m.parent
  LEFT JOIN category_meta pm ON pm.name = m.parent
)
INSERT OR IGNORE INTO categories (name, parent, system_key, kind, sort_order, hidden, created_at, updated_at)
  SELECT name, parent, NULL,
    CASE WHEN parent IS NULL THEN COALESCE(category_kind, 'expense')
      WHEN legacy_parent = 'Income' THEN 'income' WHEN legacy_parent IS NOT NULL THEN 'expense' ELSE COALESCE(parent_kind, 'expense') END,
    COALESCE(sort_order, 1010 + position), COALESCE(hidden, 0), created_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  FROM placed ORDER BY position;

-- A parent that did not arrive (a name that clashed) leaves its children at the top level.
UPDATE categories SET parent = NULL WHERE parent IS NOT NULL AND NOT EXISTS (SELECT 1 FROM categories p WHERE p.name = categories.parent);

INSERT INTO settings (key, value) SELECT 'category_seed', 'legacy' WHERE EXISTS (SELECT 1 FROM categories);

-- Undo of an edit that wrote the old tables would no longer match what the app shows: those history entries go.
DELETE FROM history_changes WHERE group_id IN (SELECT group_id FROM history_changes WHERE table_name IN ('custom_categories', 'category_meta'));
DELETE FROM history_groups WHERE NOT EXISTS (SELECT 1 FROM history_changes WHERE group_id = history_groups.id);

-- Capture for Undo and Redo (generated from src/services/history/tables.ts, checked by test/history.test.ts).
CREATE TRIGGER history_categories_insert AFTER INSERT ON categories
WHEN (SELECT group_id FROM history_state WHERE id = 1) IS NOT NULL
BEGIN
  INSERT INTO history_changes (group_id, table_name, row_key, before_image)
    SELECT (SELECT group_id FROM history_state WHERE id = 1), 'categories', json_array(NEW.name), NULL
    WHERE NOT EXISTS (SELECT 1 FROM history_changes WHERE group_id = (SELECT group_id FROM history_state WHERE id = 1) AND table_name = 'categories' AND row_key = json_array(NEW.name));
END;
CREATE TRIGGER history_categories_update BEFORE UPDATE ON categories
WHEN (SELECT group_id FROM history_state WHERE id = 1) IS NOT NULL
BEGIN
  INSERT INTO history_changes (group_id, table_name, row_key, before_image)
    SELECT (SELECT group_id FROM history_state WHERE id = 1), 'categories', json_array(OLD.name), json_object('name', OLD.name, 'parent', OLD.parent, 'system_key', OLD.system_key, 'kind', OLD.kind, 'sort_order', OLD.sort_order, 'hidden', OLD.hidden, 'created_at', OLD.created_at)
    WHERE NOT EXISTS (SELECT 1 FROM history_changes WHERE group_id = (SELECT group_id FROM history_state WHERE id = 1) AND table_name = 'categories' AND row_key = json_array(OLD.name));
  INSERT INTO history_changes (group_id, table_name, row_key, before_image)
    SELECT (SELECT group_id FROM history_state WHERE id = 1), 'categories', json_array(NEW.name), NULL
    WHERE NOT EXISTS (SELECT 1 FROM history_changes WHERE group_id = (SELECT group_id FROM history_state WHERE id = 1) AND table_name = 'categories' AND row_key = json_array(NEW.name)) AND (NEW.name IS NOT OLD.name COLLATE BINARY);
END;
CREATE TRIGGER history_categories_delete BEFORE DELETE ON categories
WHEN (SELECT group_id FROM history_state WHERE id = 1) IS NOT NULL
BEGIN
  INSERT INTO history_changes (group_id, table_name, row_key, before_image)
    SELECT (SELECT group_id FROM history_state WHERE id = 1), 'categories', json_array(OLD.name), json_object('name', OLD.name, 'parent', OLD.parent, 'system_key', OLD.system_key, 'kind', OLD.kind, 'sort_order', OLD.sort_order, 'hidden', OLD.hidden, 'created_at', OLD.created_at)
    WHERE NOT EXISTS (SELECT 1 FROM history_changes WHERE group_id = (SELECT group_id FROM history_state WHERE id = 1) AND table_name = 'categories' AND row_key = json_array(OLD.name));
END;
