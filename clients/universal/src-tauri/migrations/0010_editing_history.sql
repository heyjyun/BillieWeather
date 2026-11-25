-- Version 10: Undo and Redo (docs/architecture/editing-history.md).
-- Additive only: three tables and capture triggers. No existing row, column or trigger is changed.
--
-- One edit of a person is one history group. While a transaction has opened a group (history_state), the
-- triggers below note every row it touches, including rows changed by other triggers (refund links, staged
-- imports) and by foreign-key actions, with the row as it was before the group. The same transaction then
-- notes what the rows have become and closes the group, so an edit and its history commit together or not
-- at all, and history_state is never left open by a crash.
--
-- Rollback: the pre-migration copy (src-tauri/src/snapshot.rs). Older app versions refuse a database of this version.

CREATE TABLE history_groups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  uuid TEXT NOT NULL UNIQUE,
  at TEXT NOT NULL,
  action TEXT NOT NULL CHECK (length(action) BETWEEN 1 AND 40),
  -- NULL: done (can be undone). Otherwise undone then (can be redone until the next edit).
  undone_at TEXT
);
CREATE TABLE history_changes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  group_id INTEGER NOT NULL REFERENCES history_groups(id) ON DELETE CASCADE,
  table_name TEXT NOT NULL,
  row_key TEXT NOT NULL,
  -- The row as JSON; NULL = absent.
  before_image TEXT,
  after_image TEXT,
  UNIQUE (group_id, table_name, row_key)
);
CREATE INDEX index_history_changes_on_row ON history_changes (table_name, row_key);
-- One row. `group_id`: the group the running transaction records into. `replaying`: the running transaction
-- is an undo or redo. `conflict`: an undo or redo that would not be exact aborts here.
CREATE TABLE history_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  group_id INTEGER,
  replaying INTEGER NOT NULL DEFAULT 0,
  conflict INTEGER NOT NULL DEFAULT 0,
  CONSTRAINT history_conflict CHECK (conflict = 0)
);
INSERT INTO history_state (id) VALUES (1);

-- An entry deleted for good (the trash, "Remove from this device", a website deletion) leaves no copy in the
-- history and can never come back: every group that mentions it goes with it.
CREATE TRIGGER history_forget_deleted AFTER DELETE ON transactions
WHEN (SELECT group_id IS NULL AND replaying = 0 FROM history_state WHERE id = 1)
BEGIN
  DELETE FROM history_changes WHERE group_id IN (SELECT group_id FROM history_changes WHERE table_name = 'transactions' AND row_key = json_array(OLD.id));
  DELETE FROM history_groups WHERE NOT EXISTS (SELECT 1 FROM history_changes WHERE group_id = history_groups.id);
END;

-- Capture (generated from src/services/history/tables.ts, checked by test/history.test.ts).
CREATE TRIGGER history_settings_insert AFTER INSERT ON settings
WHEN (SELECT group_id FROM history_state WHERE id = 1) IS NOT NULL AND NEW.key IN ('currency', 'month_start_day', 'web_sync_skip')
BEGIN
  INSERT INTO history_changes (group_id, table_name, row_key, before_image)
    SELECT (SELECT group_id FROM history_state WHERE id = 1), 'settings', json_array(NEW.key), NULL
    WHERE NOT EXISTS (SELECT 1 FROM history_changes WHERE group_id = (SELECT group_id FROM history_state WHERE id = 1) AND table_name = 'settings' AND row_key = json_array(NEW.key));
END;
CREATE TRIGGER history_settings_update BEFORE UPDATE ON settings
WHEN (SELECT group_id FROM history_state WHERE id = 1) IS NOT NULL AND OLD.key IN ('currency', 'month_start_day', 'web_sync_skip')
BEGIN
  INSERT INTO history_changes (group_id, table_name, row_key, before_image)
    SELECT (SELECT group_id FROM history_state WHERE id = 1), 'settings', json_array(OLD.key), json_object('key', OLD.key, 'value', OLD.value)
    WHERE NOT EXISTS (SELECT 1 FROM history_changes WHERE group_id = (SELECT group_id FROM history_state WHERE id = 1) AND table_name = 'settings' AND row_key = json_array(OLD.key));
  INSERT INTO history_changes (group_id, table_name, row_key, before_image)
    SELECT (SELECT group_id FROM history_state WHERE id = 1), 'settings', json_array(NEW.key), NULL
    WHERE NOT EXISTS (SELECT 1 FROM history_changes WHERE group_id = (SELECT group_id FROM history_state WHERE id = 1) AND table_name = 'settings' AND row_key = json_array(NEW.key)) AND (NEW.key IS NOT OLD.key COLLATE BINARY);
END;
CREATE TRIGGER history_settings_delete BEFORE DELETE ON settings
WHEN (SELECT group_id FROM history_state WHERE id = 1) IS NOT NULL AND OLD.key IN ('currency', 'month_start_day', 'web_sync_skip')
BEGIN
  INSERT INTO history_changes (group_id, table_name, row_key, before_image)
    SELECT (SELECT group_id FROM history_state WHERE id = 1), 'settings', json_array(OLD.key), json_object('key', OLD.key, 'value', OLD.value)
    WHERE NOT EXISTS (SELECT 1 FROM history_changes WHERE group_id = (SELECT group_id FROM history_state WHERE id = 1) AND table_name = 'settings' AND row_key = json_array(OLD.key));
END;
CREATE TRIGGER history_accounts_insert AFTER INSERT ON accounts
WHEN (SELECT group_id FROM history_state WHERE id = 1) IS NOT NULL
BEGIN
  UPDATE history_changes SET before_image = NULL WHERE group_id = (SELECT group_id FROM history_state WHERE id = 1) AND table_name = 'accounts' AND row_key = json_array(NEW.id);
  INSERT INTO history_changes (group_id, table_name, row_key, before_image)
    SELECT (SELECT group_id FROM history_state WHERE id = 1), 'accounts', json_array(NEW.id), NULL
    WHERE NOT EXISTS (SELECT 1 FROM history_changes WHERE group_id = (SELECT group_id FROM history_state WHERE id = 1) AND table_name = 'accounts' AND row_key = json_array(NEW.id));
END;
CREATE TRIGGER history_accounts_update BEFORE UPDATE ON accounts
WHEN (SELECT group_id FROM history_state WHERE id = 1) IS NOT NULL
BEGIN
  INSERT INTO history_changes (group_id, table_name, row_key, before_image)
    SELECT (SELECT group_id FROM history_state WHERE id = 1), 'accounts', json_array(OLD.id), json_object('id', OLD.id, 'uuid', OLD.uuid, 'name', OLD.name, 'account_type', OLD.account_type, 'currency', OLD.currency, 'institution', OLD.institution, 'last4', OLD.last4, 'account_key', OLD.account_key, 'opening_balance_cents', OLD.opening_balance_cents, 'opening_balance_on', OLD.opening_balance_on, 'opening_balance_source', OLD.opening_balance_source, 'credit_limit_cents', OLD.credit_limit_cents, 'statement_day', OLD.statement_day, 'due_day', OLD.due_day, 'include_in_net_worth', OLD.include_in_net_worth, 'note', OLD.note, 'sort_order', OLD.sort_order, 'archived_at', OLD.archived_at, 'created_at', OLD.created_at)
    WHERE NOT EXISTS (SELECT 1 FROM history_changes WHERE group_id = (SELECT group_id FROM history_state WHERE id = 1) AND table_name = 'accounts' AND row_key = json_array(OLD.id));
END;
CREATE TRIGGER history_accounts_delete BEFORE DELETE ON accounts
WHEN (SELECT group_id FROM history_state WHERE id = 1) IS NOT NULL
BEGIN
  INSERT INTO history_changes (group_id, table_name, row_key, before_image)
    SELECT (SELECT group_id FROM history_state WHERE id = 1), 'accounts', json_array(OLD.id), json_object('id', OLD.id, 'uuid', OLD.uuid, 'name', OLD.name, 'account_type', OLD.account_type, 'currency', OLD.currency, 'institution', OLD.institution, 'last4', OLD.last4, 'account_key', OLD.account_key, 'opening_balance_cents', OLD.opening_balance_cents, 'opening_balance_on', OLD.opening_balance_on, 'opening_balance_source', OLD.opening_balance_source, 'credit_limit_cents', OLD.credit_limit_cents, 'statement_day', OLD.statement_day, 'due_day', OLD.due_day, 'include_in_net_worth', OLD.include_in_net_worth, 'note', OLD.note, 'sort_order', OLD.sort_order, 'archived_at', OLD.archived_at, 'created_at', OLD.created_at)
    WHERE NOT EXISTS (SELECT 1 FROM history_changes WHERE group_id = (SELECT group_id FROM history_state WHERE id = 1) AND table_name = 'accounts' AND row_key = json_array(OLD.id));
END;
CREATE TRIGGER history_merchants_insert AFTER INSERT ON merchants
WHEN (SELECT group_id FROM history_state WHERE id = 1) IS NOT NULL
BEGIN
  UPDATE history_changes SET before_image = NULL WHERE group_id = (SELECT group_id FROM history_state WHERE id = 1) AND table_name = 'merchants' AND row_key = json_array(NEW.id);
  INSERT INTO history_changes (group_id, table_name, row_key, before_image)
    SELECT (SELECT group_id FROM history_state WHERE id = 1), 'merchants', json_array(NEW.id), NULL
    WHERE NOT EXISTS (SELECT 1 FROM history_changes WHERE group_id = (SELECT group_id FROM history_state WHERE id = 1) AND table_name = 'merchants' AND row_key = json_array(NEW.id));
END;
CREATE TRIGGER history_merchants_update BEFORE UPDATE ON merchants
WHEN (SELECT group_id FROM history_state WHERE id = 1) IS NOT NULL
BEGIN
  INSERT INTO history_changes (group_id, table_name, row_key, before_image)
    SELECT (SELECT group_id FROM history_state WHERE id = 1), 'merchants', json_array(OLD.id), json_object('id', OLD.id, 'uuid', OLD.uuid, 'name', OLD.name, 'note', OLD.note, 'sort_order', OLD.sort_order, 'archived_at', OLD.archived_at, 'created_at', OLD.created_at)
    WHERE NOT EXISTS (SELECT 1 FROM history_changes WHERE group_id = (SELECT group_id FROM history_state WHERE id = 1) AND table_name = 'merchants' AND row_key = json_array(OLD.id));
END;
CREATE TRIGGER history_merchants_delete BEFORE DELETE ON merchants
WHEN (SELECT group_id FROM history_state WHERE id = 1) IS NOT NULL
BEGIN
  INSERT INTO history_changes (group_id, table_name, row_key, before_image)
    SELECT (SELECT group_id FROM history_state WHERE id = 1), 'merchants', json_array(OLD.id), json_object('id', OLD.id, 'uuid', OLD.uuid, 'name', OLD.name, 'note', OLD.note, 'sort_order', OLD.sort_order, 'archived_at', OLD.archived_at, 'created_at', OLD.created_at)
    WHERE NOT EXISTS (SELECT 1 FROM history_changes WHERE group_id = (SELECT group_id FROM history_state WHERE id = 1) AND table_name = 'merchants' AND row_key = json_array(OLD.id));
END;
CREATE TRIGGER history_projects_insert AFTER INSERT ON projects
WHEN (SELECT group_id FROM history_state WHERE id = 1) IS NOT NULL
BEGIN
  UPDATE history_changes SET before_image = NULL WHERE group_id = (SELECT group_id FROM history_state WHERE id = 1) AND table_name = 'projects' AND row_key = json_array(NEW.id);
  INSERT INTO history_changes (group_id, table_name, row_key, before_image)
    SELECT (SELECT group_id FROM history_state WHERE id = 1), 'projects', json_array(NEW.id), NULL
    WHERE NOT EXISTS (SELECT 1 FROM history_changes WHERE group_id = (SELECT group_id FROM history_state WHERE id = 1) AND table_name = 'projects' AND row_key = json_array(NEW.id));
END;
CREATE TRIGGER history_projects_update BEFORE UPDATE ON projects
WHEN (SELECT group_id FROM history_state WHERE id = 1) IS NOT NULL
BEGIN
  INSERT INTO history_changes (group_id, table_name, row_key, before_image)
    SELECT (SELECT group_id FROM history_state WHERE id = 1), 'projects', json_array(OLD.id), json_object('id', OLD.id, 'uuid', OLD.uuid, 'name', OLD.name, 'note', OLD.note, 'sort_order', OLD.sort_order, 'archived_at', OLD.archived_at, 'created_at', OLD.created_at)
    WHERE NOT EXISTS (SELECT 1 FROM history_changes WHERE group_id = (SELECT group_id FROM history_state WHERE id = 1) AND table_name = 'projects' AND row_key = json_array(OLD.id));
END;
CREATE TRIGGER history_projects_delete BEFORE DELETE ON projects
WHEN (SELECT group_id FROM history_state WHERE id = 1) IS NOT NULL
BEGIN
  INSERT INTO history_changes (group_id, table_name, row_key, before_image)
    SELECT (SELECT group_id FROM history_state WHERE id = 1), 'projects', json_array(OLD.id), json_object('id', OLD.id, 'uuid', OLD.uuid, 'name', OLD.name, 'note', OLD.note, 'sort_order', OLD.sort_order, 'archived_at', OLD.archived_at, 'created_at', OLD.created_at)
    WHERE NOT EXISTS (SELECT 1 FROM history_changes WHERE group_id = (SELECT group_id FROM history_state WHERE id = 1) AND table_name = 'projects' AND row_key = json_array(OLD.id));
END;
CREATE TRIGGER history_tags_insert AFTER INSERT ON tags
WHEN (SELECT group_id FROM history_state WHERE id = 1) IS NOT NULL
BEGIN
  UPDATE history_changes SET before_image = NULL WHERE group_id = (SELECT group_id FROM history_state WHERE id = 1) AND table_name = 'tags' AND row_key = json_array(NEW.id);
  INSERT INTO history_changes (group_id, table_name, row_key, before_image)
    SELECT (SELECT group_id FROM history_state WHERE id = 1), 'tags', json_array(NEW.id), NULL
    WHERE NOT EXISTS (SELECT 1 FROM history_changes WHERE group_id = (SELECT group_id FROM history_state WHERE id = 1) AND table_name = 'tags' AND row_key = json_array(NEW.id));
END;
CREATE TRIGGER history_tags_update BEFORE UPDATE ON tags
WHEN (SELECT group_id FROM history_state WHERE id = 1) IS NOT NULL
BEGIN
  INSERT INTO history_changes (group_id, table_name, row_key, before_image)
    SELECT (SELECT group_id FROM history_state WHERE id = 1), 'tags', json_array(OLD.id), json_object('id', OLD.id, 'uuid', OLD.uuid, 'name', OLD.name, 'note', OLD.note, 'sort_order', OLD.sort_order, 'archived_at', OLD.archived_at, 'created_at', OLD.created_at)
    WHERE NOT EXISTS (SELECT 1 FROM history_changes WHERE group_id = (SELECT group_id FROM history_state WHERE id = 1) AND table_name = 'tags' AND row_key = json_array(OLD.id));
END;
CREATE TRIGGER history_tags_delete BEFORE DELETE ON tags
WHEN (SELECT group_id FROM history_state WHERE id = 1) IS NOT NULL
BEGIN
  INSERT INTO history_changes (group_id, table_name, row_key, before_image)
    SELECT (SELECT group_id FROM history_state WHERE id = 1), 'tags', json_array(OLD.id), json_object('id', OLD.id, 'uuid', OLD.uuid, 'name', OLD.name, 'note', OLD.note, 'sort_order', OLD.sort_order, 'archived_at', OLD.archived_at, 'created_at', OLD.created_at)
    WHERE NOT EXISTS (SELECT 1 FROM history_changes WHERE group_id = (SELECT group_id FROM history_state WHERE id = 1) AND table_name = 'tags' AND row_key = json_array(OLD.id));
END;
CREATE TRIGGER history_recurring_rules_insert AFTER INSERT ON recurring_rules
WHEN (SELECT group_id FROM history_state WHERE id = 1) IS NOT NULL
BEGIN
  UPDATE history_changes SET before_image = NULL WHERE group_id = (SELECT group_id FROM history_state WHERE id = 1) AND table_name = 'recurring_rules' AND row_key = json_array(NEW.id);
  INSERT INTO history_changes (group_id, table_name, row_key, before_image)
    SELECT (SELECT group_id FROM history_state WHERE id = 1), 'recurring_rules', json_array(NEW.id), NULL
    WHERE NOT EXISTS (SELECT 1 FROM history_changes WHERE group_id = (SELECT group_id FROM history_state WHERE id = 1) AND table_name = 'recurring_rules' AND row_key = json_array(NEW.id));
END;
CREATE TRIGGER history_recurring_rules_update BEFORE UPDATE ON recurring_rules
WHEN (SELECT group_id FROM history_state WHERE id = 1) IS NOT NULL
BEGIN
  INSERT INTO history_changes (group_id, table_name, row_key, before_image)
    SELECT (SELECT group_id FROM history_state WHERE id = 1), 'recurring_rules', json_array(OLD.id), json_object('id', OLD.id, 'uuid', OLD.uuid, 'name', OLD.name, 'template', OLD.template, 'frequency', OLD.frequency, 'interval', OLD.interval, 'start_on', OLD.start_on, 'end_on', OLD.end_on, 'next_on', OLD.next_on, 'auto_post', OLD.auto_post, 'paused', OLD.paused, 'created_at', OLD.created_at)
    WHERE NOT EXISTS (SELECT 1 FROM history_changes WHERE group_id = (SELECT group_id FROM history_state WHERE id = 1) AND table_name = 'recurring_rules' AND row_key = json_array(OLD.id));
END;
CREATE TRIGGER history_recurring_rules_delete BEFORE DELETE ON recurring_rules
WHEN (SELECT group_id FROM history_state WHERE id = 1) IS NOT NULL
BEGIN
  INSERT INTO history_changes (group_id, table_name, row_key, before_image)
    SELECT (SELECT group_id FROM history_state WHERE id = 1), 'recurring_rules', json_array(OLD.id), json_object('id', OLD.id, 'uuid', OLD.uuid, 'name', OLD.name, 'template', OLD.template, 'frequency', OLD.frequency, 'interval', OLD.interval, 'start_on', OLD.start_on, 'end_on', OLD.end_on, 'next_on', OLD.next_on, 'auto_post', OLD.auto_post, 'paused', OLD.paused, 'created_at', OLD.created_at)
    WHERE NOT EXISTS (SELECT 1 FROM history_changes WHERE group_id = (SELECT group_id FROM history_state WHERE id = 1) AND table_name = 'recurring_rules' AND row_key = json_array(OLD.id));
END;
CREATE TRIGGER history_custom_categories_insert AFTER INSERT ON custom_categories
WHEN (SELECT group_id FROM history_state WHERE id = 1) IS NOT NULL
BEGIN
  INSERT INTO history_changes (group_id, table_name, row_key, before_image)
    SELECT (SELECT group_id FROM history_state WHERE id = 1), 'custom_categories', json_array(NEW.name), NULL
    WHERE NOT EXISTS (SELECT 1 FROM history_changes WHERE group_id = (SELECT group_id FROM history_state WHERE id = 1) AND table_name = 'custom_categories' AND row_key = json_array(NEW.name));
END;
CREATE TRIGGER history_custom_categories_update BEFORE UPDATE ON custom_categories
WHEN (SELECT group_id FROM history_state WHERE id = 1) IS NOT NULL
BEGIN
  INSERT INTO history_changes (group_id, table_name, row_key, before_image)
    SELECT (SELECT group_id FROM history_state WHERE id = 1), 'custom_categories', json_array(OLD.name), json_object('name', OLD.name, 'created_at', OLD.created_at)
    WHERE NOT EXISTS (SELECT 1 FROM history_changes WHERE group_id = (SELECT group_id FROM history_state WHERE id = 1) AND table_name = 'custom_categories' AND row_key = json_array(OLD.name));
  INSERT INTO history_changes (group_id, table_name, row_key, before_image)
    SELECT (SELECT group_id FROM history_state WHERE id = 1), 'custom_categories', json_array(NEW.name), NULL
    WHERE NOT EXISTS (SELECT 1 FROM history_changes WHERE group_id = (SELECT group_id FROM history_state WHERE id = 1) AND table_name = 'custom_categories' AND row_key = json_array(NEW.name)) AND (NEW.name IS NOT OLD.name COLLATE BINARY);
END;
CREATE TRIGGER history_custom_categories_delete BEFORE DELETE ON custom_categories
WHEN (SELECT group_id FROM history_state WHERE id = 1) IS NOT NULL
BEGIN
  INSERT INTO history_changes (group_id, table_name, row_key, before_image)
    SELECT (SELECT group_id FROM history_state WHERE id = 1), 'custom_categories', json_array(OLD.name), json_object('name', OLD.name, 'created_at', OLD.created_at)
    WHERE NOT EXISTS (SELECT 1 FROM history_changes WHERE group_id = (SELECT group_id FROM history_state WHERE id = 1) AND table_name = 'custom_categories' AND row_key = json_array(OLD.name));
END;
CREATE TRIGGER history_category_meta_insert AFTER INSERT ON category_meta
WHEN (SELECT group_id FROM history_state WHERE id = 1) IS NOT NULL
BEGIN
  INSERT INTO history_changes (group_id, table_name, row_key, before_image)
    SELECT (SELECT group_id FROM history_state WHERE id = 1), 'category_meta', json_array(NEW.name), NULL
    WHERE NOT EXISTS (SELECT 1 FROM history_changes WHERE group_id = (SELECT group_id FROM history_state WHERE id = 1) AND table_name = 'category_meta' AND row_key = json_array(NEW.name));
END;
CREATE TRIGGER history_category_meta_update BEFORE UPDATE ON category_meta
WHEN (SELECT group_id FROM history_state WHERE id = 1) IS NOT NULL
BEGIN
  INSERT INTO history_changes (group_id, table_name, row_key, before_image)
    SELECT (SELECT group_id FROM history_state WHERE id = 1), 'category_meta', json_array(OLD.name), json_object('name', OLD.name, 'parent', OLD.parent, 'category_kind', OLD.category_kind, 'sort_order', OLD.sort_order, 'hidden', OLD.hidden)
    WHERE NOT EXISTS (SELECT 1 FROM history_changes WHERE group_id = (SELECT group_id FROM history_state WHERE id = 1) AND table_name = 'category_meta' AND row_key = json_array(OLD.name));
  INSERT INTO history_changes (group_id, table_name, row_key, before_image)
    SELECT (SELECT group_id FROM history_state WHERE id = 1), 'category_meta', json_array(NEW.name), NULL
    WHERE NOT EXISTS (SELECT 1 FROM history_changes WHERE group_id = (SELECT group_id FROM history_state WHERE id = 1) AND table_name = 'category_meta' AND row_key = json_array(NEW.name)) AND (NEW.name IS NOT OLD.name COLLATE BINARY);
END;
CREATE TRIGGER history_category_meta_delete BEFORE DELETE ON category_meta
WHEN (SELECT group_id FROM history_state WHERE id = 1) IS NOT NULL
BEGIN
  INSERT INTO history_changes (group_id, table_name, row_key, before_image)
    SELECT (SELECT group_id FROM history_state WHERE id = 1), 'category_meta', json_array(OLD.name), json_object('name', OLD.name, 'parent', OLD.parent, 'category_kind', OLD.category_kind, 'sort_order', OLD.sort_order, 'hidden', OLD.hidden)
    WHERE NOT EXISTS (SELECT 1 FROM history_changes WHERE group_id = (SELECT group_id FROM history_state WHERE id = 1) AND table_name = 'category_meta' AND row_key = json_array(OLD.name));
END;
CREATE TRIGGER history_merchant_rules_insert AFTER INSERT ON merchant_rules
WHEN (SELECT group_id FROM history_state WHERE id = 1) IS NOT NULL
BEGIN
  INSERT INTO history_changes (group_id, table_name, row_key, before_image)
    SELECT (SELECT group_id FROM history_state WHERE id = 1), 'merchant_rules', json_array(NEW.merchant_key, NEW.income), NULL
    WHERE NOT EXISTS (SELECT 1 FROM history_changes WHERE group_id = (SELECT group_id FROM history_state WHERE id = 1) AND table_name = 'merchant_rules' AND row_key = json_array(NEW.merchant_key, NEW.income));
END;
CREATE TRIGGER history_merchant_rules_update BEFORE UPDATE ON merchant_rules
WHEN (SELECT group_id FROM history_state WHERE id = 1) IS NOT NULL
BEGIN
  INSERT INTO history_changes (group_id, table_name, row_key, before_image)
    SELECT (SELECT group_id FROM history_state WHERE id = 1), 'merchant_rules', json_array(OLD.merchant_key, OLD.income), json_object('merchant_key', OLD.merchant_key, 'income', OLD.income, 'category', OLD.category)
    WHERE NOT EXISTS (SELECT 1 FROM history_changes WHERE group_id = (SELECT group_id FROM history_state WHERE id = 1) AND table_name = 'merchant_rules' AND row_key = json_array(OLD.merchant_key, OLD.income));
  INSERT INTO history_changes (group_id, table_name, row_key, before_image)
    SELECT (SELECT group_id FROM history_state WHERE id = 1), 'merchant_rules', json_array(NEW.merchant_key, NEW.income), NULL
    WHERE NOT EXISTS (SELECT 1 FROM history_changes WHERE group_id = (SELECT group_id FROM history_state WHERE id = 1) AND table_name = 'merchant_rules' AND row_key = json_array(NEW.merchant_key, NEW.income)) AND (NEW.merchant_key IS NOT OLD.merchant_key COLLATE BINARY OR NEW.income IS NOT OLD.income COLLATE BINARY);
END;
CREATE TRIGGER history_merchant_rules_delete BEFORE DELETE ON merchant_rules
WHEN (SELECT group_id FROM history_state WHERE id = 1) IS NOT NULL
BEGIN
  INSERT INTO history_changes (group_id, table_name, row_key, before_image)
    SELECT (SELECT group_id FROM history_state WHERE id = 1), 'merchant_rules', json_array(OLD.merchant_key, OLD.income), json_object('merchant_key', OLD.merchant_key, 'income', OLD.income, 'category', OLD.category)
    WHERE NOT EXISTS (SELECT 1 FROM history_changes WHERE group_id = (SELECT group_id FROM history_state WHERE id = 1) AND table_name = 'merchant_rules' AND row_key = json_array(OLD.merchant_key, OLD.income));
END;
CREATE TRIGGER history_statements_insert AFTER INSERT ON statements
WHEN (SELECT group_id FROM history_state WHERE id = 1) IS NOT NULL AND NEW.source_format IS NOT 'manual'
BEGIN
  UPDATE history_changes SET before_image = NULL WHERE group_id = (SELECT group_id FROM history_state WHERE id = 1) AND table_name = 'statements' AND row_key = json_array(NEW.id);
  INSERT INTO history_changes (group_id, table_name, row_key, before_image)
    SELECT (SELECT group_id FROM history_state WHERE id = 1), 'statements', json_array(NEW.id), NULL
    WHERE NOT EXISTS (SELECT 1 FROM history_changes WHERE group_id = (SELECT group_id FROM history_state WHERE id = 1) AND table_name = 'statements' AND row_key = json_array(NEW.id));
END;
CREATE TRIGGER history_statements_update BEFORE UPDATE ON statements
WHEN (SELECT group_id FROM history_state WHERE id = 1) IS NOT NULL AND OLD.source_format IS NOT 'manual'
BEGIN
  INSERT INTO history_changes (group_id, table_name, row_key, before_image)
    SELECT (SELECT group_id FROM history_state WHERE id = 1), 'statements', json_array(OLD.id), json_object('id', OLD.id, 'filename', OLD.filename, 'currency', OLD.currency, 'sha256', OLD.sha256, 'transaction_count', OLD.transaction_count, 'closing_balance_cents', OLD.closing_balance_cents, 'closing_balance_on', OLD.closing_balance_on, 'imported_at', OLD.imported_at, 'source', OLD.source, 'remote_id', OLD.remote_id, 'import_batch_id', OLD.import_batch_id, 'source_sha256', OLD.source_sha256, 'source_format', OLD.source_format, 'account_key', OLD.account_key, 'institution', OLD.institution, 'account_last4', OLD.account_last4, 'account_kind', OLD.account_kind, 'opening_balance_cents', OLD.opening_balance_cents, 'opening_balance_on', OLD.opening_balance_on, 'import_report', OLD.import_report, 'region', OLD.region, 'region_source', OLD.region_source, 'detected_region', OLD.detected_region, 'region_confidence', OLD.region_confidence, 'region_evidence', OLD.region_evidence, 'account_id', OLD.account_id)
    WHERE NOT EXISTS (SELECT 1 FROM history_changes WHERE group_id = (SELECT group_id FROM history_state WHERE id = 1) AND table_name = 'statements' AND row_key = json_array(OLD.id));
END;
CREATE TRIGGER history_statements_delete BEFORE DELETE ON statements
WHEN (SELECT group_id FROM history_state WHERE id = 1) IS NOT NULL AND OLD.source_format IS NOT 'manual'
BEGIN
  INSERT INTO history_changes (group_id, table_name, row_key, before_image)
    SELECT (SELECT group_id FROM history_state WHERE id = 1), 'statements', json_array(OLD.id), json_object('id', OLD.id, 'filename', OLD.filename, 'currency', OLD.currency, 'sha256', OLD.sha256, 'transaction_count', OLD.transaction_count, 'closing_balance_cents', OLD.closing_balance_cents, 'closing_balance_on', OLD.closing_balance_on, 'imported_at', OLD.imported_at, 'source', OLD.source, 'remote_id', OLD.remote_id, 'import_batch_id', OLD.import_batch_id, 'source_sha256', OLD.source_sha256, 'source_format', OLD.source_format, 'account_key', OLD.account_key, 'institution', OLD.institution, 'account_last4', OLD.account_last4, 'account_kind', OLD.account_kind, 'opening_balance_cents', OLD.opening_balance_cents, 'opening_balance_on', OLD.opening_balance_on, 'import_report', OLD.import_report, 'region', OLD.region, 'region_source', OLD.region_source, 'detected_region', OLD.detected_region, 'region_confidence', OLD.region_confidence, 'region_evidence', OLD.region_evidence, 'account_id', OLD.account_id)
    WHERE NOT EXISTS (SELECT 1 FROM history_changes WHERE group_id = (SELECT group_id FROM history_state WHERE id = 1) AND table_name = 'statements' AND row_key = json_array(OLD.id));
END;
CREATE TRIGGER history_transactions_insert AFTER INSERT ON transactions
WHEN (SELECT group_id FROM history_state WHERE id = 1) IS NOT NULL
BEGIN
  UPDATE history_changes SET before_image = NULL WHERE group_id = (SELECT group_id FROM history_state WHERE id = 1) AND table_name = 'transactions' AND row_key = json_array(NEW.id);
  INSERT INTO history_changes (group_id, table_name, row_key, before_image)
    SELECT (SELECT group_id FROM history_state WHERE id = 1), 'transactions', json_array(NEW.id), NULL
    WHERE NOT EXISTS (SELECT 1 FROM history_changes WHERE group_id = (SELECT group_id FROM history_state WHERE id = 1) AND table_name = 'transactions' AND row_key = json_array(NEW.id));
END;
CREATE TRIGGER history_transactions_update BEFORE UPDATE ON transactions
WHEN (SELECT group_id FROM history_state WHERE id = 1) IS NOT NULL
BEGIN
  INSERT INTO history_changes (group_id, table_name, row_key, before_image)
    SELECT (SELECT group_id FROM history_state WHERE id = 1), 'transactions', json_array(OLD.id), json_object('id', OLD.id, 'statement_id', OLD.statement_id, 'booked_on', OLD.booked_on, 'description', OLD.description, 'amount_cents', OLD.amount_cents, 'category', OLD.category, 'tax_review', OLD.tax_review, 'excluded', OLD.excluded, 'remote_id', OLD.remote_id, 'locally_modified', OLD.locally_modified, 'posted_on', OLD.posted_on, 'normalized_merchant', OLD.normalized_merchant, 'currency', OLD.currency, 'direction', OLD.direction, 'balance_cents', OLD.balance_cents, 'bank_reference', OLD.bank_reference, 'account_key', OLD.account_key, 'category_source', OLD.category_source, 'pending', OLD.pending, 'kind_hints', OLD.kind_hints, 'source_ref', OLD.source_ref, 'parse_confidence', OLD.parse_confidence, 'validation_status', OLD.validation_status, 'source_raw', OLD.source_raw, 'uuid', OLD.uuid, 'kind', OLD.kind, 'account_id', OLD.account_id, 'original_description', OLD.original_description, 'entry_origin', OLD.entry_origin, 'merchant_id', OLD.merchant_id, 'project_id', OLD.project_id, 'note', OLD.note, 'occurred_at_time', OLD.occurred_at_time, 'deleted_at', OLD.deleted_at, 'user_locked_fields', OLD.user_locked_fields, 'category_confidence', OLD.category_confidence, 'category_model', OLD.category_model, 'recurring_rule_id', OLD.recurring_rule_id, 'recurring_on', OLD.recurring_on)
    WHERE NOT EXISTS (SELECT 1 FROM history_changes WHERE group_id = (SELECT group_id FROM history_state WHERE id = 1) AND table_name = 'transactions' AND row_key = json_array(OLD.id));
END;
CREATE TRIGGER history_transactions_delete BEFORE DELETE ON transactions
WHEN (SELECT group_id FROM history_state WHERE id = 1) IS NOT NULL
BEGIN
  INSERT INTO history_changes (group_id, table_name, row_key, before_image)
    SELECT (SELECT group_id FROM history_state WHERE id = 1), 'transactions', json_array(OLD.id), json_object('id', OLD.id, 'statement_id', OLD.statement_id, 'booked_on', OLD.booked_on, 'description', OLD.description, 'amount_cents', OLD.amount_cents, 'category', OLD.category, 'tax_review', OLD.tax_review, 'excluded', OLD.excluded, 'remote_id', OLD.remote_id, 'locally_modified', OLD.locally_modified, 'posted_on', OLD.posted_on, 'normalized_merchant', OLD.normalized_merchant, 'currency', OLD.currency, 'direction', OLD.direction, 'balance_cents', OLD.balance_cents, 'bank_reference', OLD.bank_reference, 'account_key', OLD.account_key, 'category_source', OLD.category_source, 'pending', OLD.pending, 'kind_hints', OLD.kind_hints, 'source_ref', OLD.source_ref, 'parse_confidence', OLD.parse_confidence, 'validation_status', OLD.validation_status, 'source_raw', OLD.source_raw, 'uuid', OLD.uuid, 'kind', OLD.kind, 'account_id', OLD.account_id, 'original_description', OLD.original_description, 'entry_origin', OLD.entry_origin, 'merchant_id', OLD.merchant_id, 'project_id', OLD.project_id, 'note', OLD.note, 'occurred_at_time', OLD.occurred_at_time, 'deleted_at', OLD.deleted_at, 'user_locked_fields', OLD.user_locked_fields, 'category_confidence', OLD.category_confidence, 'category_model', OLD.category_model, 'recurring_rule_id', OLD.recurring_rule_id, 'recurring_on', OLD.recurring_on)
    WHERE NOT EXISTS (SELECT 1 FROM history_changes WHERE group_id = (SELECT group_id FROM history_state WHERE id = 1) AND table_name = 'transactions' AND row_key = json_array(OLD.id));
END;
CREATE TRIGGER history_transaction_tags_insert AFTER INSERT ON transaction_tags
WHEN (SELECT group_id FROM history_state WHERE id = 1) IS NOT NULL
BEGIN
  INSERT INTO history_changes (group_id, table_name, row_key, before_image)
    SELECT (SELECT group_id FROM history_state WHERE id = 1), 'transaction_tags', json_array(NEW.transaction_id, NEW.tag_id), NULL
    WHERE NOT EXISTS (SELECT 1 FROM history_changes WHERE group_id = (SELECT group_id FROM history_state WHERE id = 1) AND table_name = 'transaction_tags' AND row_key = json_array(NEW.transaction_id, NEW.tag_id));
END;
CREATE TRIGGER history_transaction_tags_update BEFORE UPDATE ON transaction_tags
WHEN (SELECT group_id FROM history_state WHERE id = 1) IS NOT NULL
BEGIN
  INSERT INTO history_changes (group_id, table_name, row_key, before_image)
    SELECT (SELECT group_id FROM history_state WHERE id = 1), 'transaction_tags', json_array(OLD.transaction_id, OLD.tag_id), json_object('transaction_id', OLD.transaction_id, 'tag_id', OLD.tag_id)
    WHERE NOT EXISTS (SELECT 1 FROM history_changes WHERE group_id = (SELECT group_id FROM history_state WHERE id = 1) AND table_name = 'transaction_tags' AND row_key = json_array(OLD.transaction_id, OLD.tag_id));
  INSERT INTO history_changes (group_id, table_name, row_key, before_image)
    SELECT (SELECT group_id FROM history_state WHERE id = 1), 'transaction_tags', json_array(NEW.transaction_id, NEW.tag_id), NULL
    WHERE NOT EXISTS (SELECT 1 FROM history_changes WHERE group_id = (SELECT group_id FROM history_state WHERE id = 1) AND table_name = 'transaction_tags' AND row_key = json_array(NEW.transaction_id, NEW.tag_id)) AND (NEW.transaction_id IS NOT OLD.transaction_id COLLATE BINARY OR NEW.tag_id IS NOT OLD.tag_id COLLATE BINARY);
END;
CREATE TRIGGER history_transaction_tags_delete BEFORE DELETE ON transaction_tags
WHEN (SELECT group_id FROM history_state WHERE id = 1) IS NOT NULL
BEGIN
  INSERT INTO history_changes (group_id, table_name, row_key, before_image)
    SELECT (SELECT group_id FROM history_state WHERE id = 1), 'transaction_tags', json_array(OLD.transaction_id, OLD.tag_id), json_object('transaction_id', OLD.transaction_id, 'tag_id', OLD.tag_id)
    WHERE NOT EXISTS (SELECT 1 FROM history_changes WHERE group_id = (SELECT group_id FROM history_state WHERE id = 1) AND table_name = 'transaction_tags' AND row_key = json_array(OLD.transaction_id, OLD.tag_id));
END;
CREATE TRIGGER history_transaction_links_insert AFTER INSERT ON transaction_links
WHEN (SELECT group_id FROM history_state WHERE id = 1) IS NOT NULL
BEGIN
  UPDATE history_changes SET before_image = NULL WHERE group_id = (SELECT group_id FROM history_state WHERE id = 1) AND table_name = 'transaction_links' AND row_key = json_array(NEW.id);
  INSERT INTO history_changes (group_id, table_name, row_key, before_image)
    SELECT (SELECT group_id FROM history_state WHERE id = 1), 'transaction_links', json_array(NEW.id), NULL
    WHERE NOT EXISTS (SELECT 1 FROM history_changes WHERE group_id = (SELECT group_id FROM history_state WHERE id = 1) AND table_name = 'transaction_links' AND row_key = json_array(NEW.id));
END;
CREATE TRIGGER history_transaction_links_update BEFORE UPDATE ON transaction_links
WHEN (SELECT group_id FROM history_state WHERE id = 1) IS NOT NULL
BEGIN
  INSERT INTO history_changes (group_id, table_name, row_key, before_image)
    SELECT (SELECT group_id FROM history_state WHERE id = 1), 'transaction_links', json_array(OLD.id), json_object('id', OLD.id, 'uuid', OLD.uuid, 'link_type', OLD.link_type, 'from_transaction_id', OLD.from_transaction_id, 'to_transaction_id', OLD.to_transaction_id, 'amount_cents', OLD.amount_cents, 'status', OLD.status, 'decided_by', OLD.decided_by, 'created_at', OLD.created_at)
    WHERE NOT EXISTS (SELECT 1 FROM history_changes WHERE group_id = (SELECT group_id FROM history_state WHERE id = 1) AND table_name = 'transaction_links' AND row_key = json_array(OLD.id));
END;
CREATE TRIGGER history_transaction_links_delete BEFORE DELETE ON transaction_links
WHEN (SELECT group_id FROM history_state WHERE id = 1) IS NOT NULL
BEGIN
  INSERT INTO history_changes (group_id, table_name, row_key, before_image)
    SELECT (SELECT group_id FROM history_state WHERE id = 1), 'transaction_links', json_array(OLD.id), json_object('id', OLD.id, 'uuid', OLD.uuid, 'link_type', OLD.link_type, 'from_transaction_id', OLD.from_transaction_id, 'to_transaction_id', OLD.to_transaction_id, 'amount_cents', OLD.amount_cents, 'status', OLD.status, 'decided_by', OLD.decided_by, 'created_at', OLD.created_at)
    WHERE NOT EXISTS (SELECT 1 FROM history_changes WHERE group_id = (SELECT group_id FROM history_state WHERE id = 1) AND table_name = 'transaction_links' AND row_key = json_array(OLD.id));
END;
CREATE TRIGGER history_budgets_insert AFTER INSERT ON budgets
WHEN (SELECT group_id FROM history_state WHERE id = 1) IS NOT NULL
BEGIN
  UPDATE history_changes SET before_image = NULL WHERE group_id = (SELECT group_id FROM history_state WHERE id = 1) AND table_name = 'budgets' AND row_key = json_array(NEW.id);
  INSERT INTO history_changes (group_id, table_name, row_key, before_image)
    SELECT (SELECT group_id FROM history_state WHERE id = 1), 'budgets', json_array(NEW.id), NULL
    WHERE NOT EXISTS (SELECT 1 FROM history_changes WHERE group_id = (SELECT group_id FROM history_state WHERE id = 1) AND table_name = 'budgets' AND row_key = json_array(NEW.id));
END;
CREATE TRIGGER history_budgets_update BEFORE UPDATE ON budgets
WHEN (SELECT group_id FROM history_state WHERE id = 1) IS NOT NULL
BEGIN
  INSERT INTO history_changes (group_id, table_name, row_key, before_image)
    SELECT (SELECT group_id FROM history_state WHERE id = 1), 'budgets', json_array(OLD.id), json_object('id', OLD.id, 'uuid', OLD.uuid, 'period', OLD.period, 'category', OLD.category, 'project_id', OLD.project_id, 'amount_cents', OLD.amount_cents, 'alert_percent', OLD.alert_percent, 'created_at', OLD.created_at)
    WHERE NOT EXISTS (SELECT 1 FROM history_changes WHERE group_id = (SELECT group_id FROM history_state WHERE id = 1) AND table_name = 'budgets' AND row_key = json_array(OLD.id));
END;
CREATE TRIGGER history_budgets_delete BEFORE DELETE ON budgets
WHEN (SELECT group_id FROM history_state WHERE id = 1) IS NOT NULL
BEGIN
  INSERT INTO history_changes (group_id, table_name, row_key, before_image)
    SELECT (SELECT group_id FROM history_state WHERE id = 1), 'budgets', json_array(OLD.id), json_object('id', OLD.id, 'uuid', OLD.uuid, 'period', OLD.period, 'category', OLD.category, 'project_id', OLD.project_id, 'amount_cents', OLD.amount_cents, 'alert_percent', OLD.alert_percent, 'created_at', OLD.created_at)
    WHERE NOT EXISTS (SELECT 1 FROM history_changes WHERE group_id = (SELECT group_id FROM history_state WHERE id = 1) AND table_name = 'budgets' AND row_key = json_array(OLD.id));
END;
CREATE TRIGGER history_organize_runs_update BEFORE UPDATE ON organize_runs
WHEN (SELECT group_id FROM history_state WHERE id = 1) IS NOT NULL
BEGIN
  INSERT INTO history_changes (group_id, table_name, row_key, before_image)
    SELECT (SELECT group_id FROM history_state WHERE id = 1), 'organize_runs', json_array(OLD.id), json_object('id', OLD.id, 'status', OLD.status, 'applied_at', OLD.applied_at, 'undone_at', OLD.undone_at, 'batch_id', OLD.batch_id)
    WHERE NOT EXISTS (SELECT 1 FROM history_changes WHERE group_id = (SELECT group_id FROM history_state WHERE id = 1) AND table_name = 'organize_runs' AND row_key = json_array(OLD.id));
END;
