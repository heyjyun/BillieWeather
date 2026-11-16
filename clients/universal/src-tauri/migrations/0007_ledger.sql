-- Version 7: the hybrid ledger (docs/architecture/finance-domain-spec.md §4).
-- Additive only: new tables, new nullable/defaulted columns, one trigger replaced. No existing
-- value is changed; new columns are filled from data the rows already have, so every total the
-- app showed before this migration is reproduced exactly (kind = legacy rule: Transfers -> transfer,
-- positive -> income, otherwise expense). The Rust side copies the database file before this runs
-- (src-tauri/src/snapshot.rs).
--
-- Rollback: restore the automatic pre-migration copy (billieweather*.db.pre-v7-*.bak) or a backup
-- file; older app versions refuse a database migrated past their version.

-- A random RFC 4122 v4-shaped id, written out where needed (SQLite has no uuid function).
-- lower(hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-4' || substr(hex(randomblob(2)), 2) || '-' ||
--   substr('89ab', 1 + (abs(random()) % 4), 1) || substr(hex(randomblob(2)), 2) || '-' || hex(randomblob(6)))

-- Accounts (账户): where money is. Imported statements link through account_key.
CREATE TABLE IF NOT EXISTS accounts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  uuid TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 60),
  account_type TEXT NOT NULL CHECK (account_type IN ('checking','savings','cash','payment_app','investment','receivable','credit_card','loan','other')),
  currency TEXT NOT NULL,
  institution TEXT,
  last4 TEXT,
  account_key TEXT UNIQUE,
  opening_balance_cents INTEGER NOT NULL DEFAULT 0,
  opening_balance_on TEXT,
  -- 'user' (typed), 'statement' (derived from an imported closing balance), 'unknown'.
  opening_balance_source TEXT NOT NULL DEFAULT 'user' CHECK (opening_balance_source IN ('user','statement','unknown')),
  credit_limit_cents INTEGER CHECK (credit_limit_cents IS NULL OR credit_limit_cents >= 0),
  statement_day INTEGER CHECK (statement_day IS NULL OR statement_day BETWEEN 1 AND 31),
  due_day INTEGER CHECK (due_day IS NULL OR due_day BETWEEN 1 AND 31),
  include_in_net_worth INTEGER NOT NULL DEFAULT 1 CHECK (include_in_net_worth IN (0, 1)),
  note TEXT CHECK (note IS NULL OR length(note) <= 500),
  sort_order INTEGER NOT NULL DEFAULT 0,
  archived_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

ALTER TABLE statements ADD COLUMN account_id INTEGER REFERENCES accounts(id);

-- Transactions: explicit economic kind, account, immutable original text, dimensions, trash.
ALTER TABLE transactions ADD COLUMN uuid TEXT;
ALTER TABLE transactions ADD COLUMN kind TEXT NOT NULL DEFAULT 'expense' CHECK (kind IN ('expense','income','refund','transfer','card_payment','opening_balance','adjustment','ignored'));
ALTER TABLE transactions ADD COLUMN account_id INTEGER REFERENCES accounts(id);
ALTER TABLE transactions ADD COLUMN original_description TEXT;
ALTER TABLE transactions ADD COLUMN entry_origin TEXT NOT NULL DEFAULT 'import' CHECK (entry_origin IN ('import','manual','web_copy','upload','recurring','legacy'));
ALTER TABLE transactions ADD COLUMN merchant_id INTEGER REFERENCES merchants(id);
ALTER TABLE transactions ADD COLUMN project_id INTEGER REFERENCES projects(id);
ALTER TABLE transactions ADD COLUMN note TEXT CHECK (note IS NULL OR length(note) <= 500);
ALTER TABLE transactions ADD COLUMN occurred_at_time TEXT CHECK (occurred_at_time IS NULL OR occurred_at_time GLOB '[0-2][0-9]:[0-5][0-9]');
ALTER TABLE transactions ADD COLUMN deleted_at TEXT;
-- JSON array of fields a person set (financial-schema.json locked_fields); automation never changes them.
ALTER TABLE transactions ADD COLUMN user_locked_fields TEXT;
ALTER TABLE transactions ADD COLUMN category_confidence INTEGER CHECK (category_confidence IS NULL OR category_confidence BETWEEN 0 AND 100);
ALTER TABLE transactions ADD COLUMN category_model TEXT;
ALTER TABLE transactions ADD COLUMN recurring_rule_id INTEGER REFERENCES recurring_rules(id) ON DELETE SET NULL;
ALTER TABLE transactions ADD COLUMN recurring_on TEXT;
-- Insert-time helpers so that an entry and its link are written by ONE statement (the SQL plugin
-- pools connections, so BEGIN/COMMIT across statements is not reliable). See the link triggers below.
ALTER TABLE transactions ADD COLUMN link_group TEXT;
ALTER TABLE transactions ADD COLUMN link_hint TEXT CHECK (link_hint IS NULL OR link_hint IN ('transfer','card_payment','refund_of'));
ALTER TABLE transactions ADD COLUMN link_target_id INTEGER;

CREATE TABLE IF NOT EXISTS merchants (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  uuid TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE CHECK (length(name) BETWEEN 1 AND 60),
  note TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  archived_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS projects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  uuid TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE CHECK (length(name) BETWEEN 1 AND 60),
  note TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  archived_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS tags (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  uuid TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE CHECK (length(name) BETWEEN 1 AND 40),
  note TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  archived_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS transaction_tags (
  transaction_id INTEGER NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
  tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  PRIMARY KEY (transaction_id, tag_id)
);

-- Relations between entries: transfers, card payments, refunds (partial), duplicates.
CREATE TABLE IF NOT EXISTS transaction_links (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  uuid TEXT NOT NULL UNIQUE,
  link_type TEXT NOT NULL CHECK (link_type IN ('transfer','card_payment','refund_of','duplicate_of','pending_to_posted')),
  from_transaction_id INTEGER NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
  to_transaction_id INTEGER REFERENCES transactions(id) ON DELETE CASCADE,
  amount_cents INTEGER,
  status TEXT NOT NULL DEFAULT 'confirmed' CHECK (status IN ('suggested','confirmed','rejected')),
  decided_by TEXT NOT NULL DEFAULT 'user' CHECK (decided_by IN ('user','rule','auto','ai')),
  created_at TEXT NOT NULL,
  UNIQUE (link_type, from_transaction_id, to_transaction_id)
);
CREATE INDEX IF NOT EXISTS index_transaction_links_on_to ON transaction_links (to_transaction_id);

-- Category tree and display settings, keyed by name (built-in or custom_categories.name).
CREATE TABLE IF NOT EXISTS category_meta (
  name TEXT PRIMARY KEY NOT NULL COLLATE NOCASE,
  parent TEXT COLLATE NOCASE,
  category_kind TEXT NOT NULL DEFAULT 'expense' CHECK (category_kind IN ('expense','income')),
  sort_order INTEGER NOT NULL DEFAULT 0,
  hidden INTEGER NOT NULL DEFAULT 0 CHECK (hidden IN (0, 1)),
  updated_at TEXT NOT NULL,
  CHECK (parent IS NULL OR parent <> name)
);

CREATE TABLE IF NOT EXISTS budgets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  uuid TEXT NOT NULL UNIQUE,
  period TEXT NOT NULL CHECK (period IN ('month','year')),
  -- NULL category and project = the overall budget.
  category TEXT COLLATE NOCASE,
  project_id INTEGER REFERENCES projects(id) ON DELETE CASCADE,
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  alert_percent INTEGER NOT NULL DEFAULT 90 CHECK (alert_percent BETWEEN 1 AND 100),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS index_budgets_on_scope ON budgets (period, COALESCE(category, ''), COALESCE(project_id, 0));

CREATE TABLE IF NOT EXISTS recurring_rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  uuid TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 60),
  -- JSON: { kind, amountCents, accountId, toAccountId?, category, merchantId?, projectId?, tagIds?, note?, description }
  template TEXT NOT NULL,
  frequency TEXT NOT NULL CHECK (frequency IN ('daily','weekly','monthly','yearly')),
  interval INTEGER NOT NULL DEFAULT 1 CHECK (interval BETWEEN 1 AND 365),
  start_on TEXT NOT NULL,
  end_on TEXT,
  next_on TEXT,
  auto_post INTEGER NOT NULL DEFAULT 0 CHECK (auto_post IN (0, 1)),
  paused INTEGER NOT NULL DEFAULT 0 CHECK (paused IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS index_transactions_on_recurrence ON transactions (recurring_rule_id, recurring_on, account_id) WHERE recurring_rule_id IS NOT NULL;

-- Operation log (操作日志). Append-only: see the triggers below.
CREATE TABLE IF NOT EXISTS audit_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  uuid TEXT NOT NULL UNIQUE,
  at TEXT NOT NULL,
  actor TEXT NOT NULL CHECK (actor IN ('user','import','rule','ai','system','sync','recurring')),
  action TEXT NOT NULL,
  subject_type TEXT NOT NULL,
  subject_id TEXT,
  batch_id TEXT,
  summary TEXT,
  -- JSON {field: [before, after]}; values stay on this device.
  changes TEXT,
  -- JSON instructions to reverse this event (used by undo of AI batches and the trash).
  undo TEXT
);
CREATE INDEX IF NOT EXISTS index_audit_events_on_at ON audit_events (at);
CREATE INDEX IF NOT EXISTS index_audit_events_on_batch ON audit_events (batch_id) WHERE batch_id IS NOT NULL;
CREATE TRIGGER IF NOT EXISTS audit_events_append_only_update BEFORE UPDATE ON audit_events
BEGIN
  SELECT RAISE(ABORT, 'audit_events_append_only');
END;
CREATE TRIGGER IF NOT EXISTS audit_events_append_only_delete BEFORE DELETE ON audit_events
WHEN COALESCE((SELECT value FROM settings WHERE key = 'audit_purge'), '0') <> '1'
BEGIN
  SELECT RAISE(ABORT, 'audit_events_append_only');
END;

-- "Organize with AI" runs: proposals, what was applied, and whether it was undone.
CREATE TABLE IF NOT EXISTS organize_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  uuid TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('preview','applied','undone','discarded')),
  engine TEXT NOT NULL,
  proposals TEXT NOT NULL,
  applied_at TEXT,
  undone_at TEXT,
  batch_id TEXT
);

-- Imports carry the new fields through the atomic commit trigger.
ALTER TABLE import_staging_rows ADD COLUMN kind TEXT;
ALTER TABLE import_staging_rows ADD COLUMN account_id INTEGER;
ALTER TABLE import_staging_rows ADD COLUMN original_description TEXT;

DROP TRIGGER IF EXISTS statements_commit_staged;
CREATE TRIGGER statements_commit_staged AFTER INSERT ON statements
WHEN NEW.import_batch_id IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'import_incomplete')
    WHERE (SELECT COUNT(*) FROM import_staging_rows WHERE staging_key = NEW.sha256) <> NEW.transaction_count;
  INSERT INTO transactions (statement_id, booked_on, description, amount_cents, category, tax_review, excluded, updated_at,
    posted_on, normalized_merchant, currency, direction, balance_cents, bank_reference, account_key, category_source, pending,
    kind_hints, source_ref, parse_confidence, validation_status, source_raw, kind, account_id, original_description, entry_origin)
  SELECT NEW.id, booked_on, description, amount_cents, category, tax_review, 0, NEW.imported_at,
    posted_on, normalized_merchant, currency, direction, balance_cents, bank_reference, account_key, category_source, pending,
    kind_hints, source_ref, parse_confidence, validation_status, source_raw,
    COALESCE(kind, CASE WHEN category = 'Transfers' THEN 'transfer' WHEN amount_cents > 0 THEN 'income' ELSE 'expense' END),
    COALESCE(account_id, NEW.account_id), COALESCE(original_description, description), 'import'
  FROM import_staging_rows WHERE staging_key = NEW.sha256 ORDER BY position;
  DELETE FROM import_staging_rows WHERE staging_key = NEW.sha256;
  INSERT OR IGNORE INTO settings (key, value) VALUES ('currency', NEW.currency);
END;

-- Every insert path (imports, website copies, merges, manual entries) gets an id and keeps its original text.
CREATE TRIGGER IF NOT EXISTS transactions_fill_identity AFTER INSERT ON transactions
WHEN NEW.uuid IS NULL OR NEW.original_description IS NULL
BEGIN
  UPDATE transactions SET
    uuid = COALESCE(uuid, lower(hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-4' || substr(hex(randomblob(2)), 2) || '-' ||
      substr('89ab', 1 + (abs(random()) % 4), 1) || substr(hex(randomblob(2)), 2) || '-' || hex(randomblob(6)))),
    original_description = COALESCE(original_description, description)
  WHERE id = NEW.id;
END;

-- The bank's original text is evidence: once set it never changes (invariant I-8).
CREATE TRIGGER IF NOT EXISTS transactions_original_immutable BEFORE UPDATE OF original_description ON transactions
WHEN OLD.original_description IS NOT NULL AND NEW.original_description IS NOT OLD.original_description
BEGIN
  SELECT RAISE(ABORT, 'original_description_immutable');
END;

-- A manual transfer is one INSERT of two rows sharing link_group: the outflow leg first, then the
-- inflow leg, whose insert creates the confirmed link. Without its outflow leg the INSERT aborts.
CREATE TRIGGER IF NOT EXISTS transactions_link_pair AFTER INSERT ON transactions
WHEN NEW.link_group IS NOT NULL AND NEW.amount_cents > 0
BEGIN
  SELECT RAISE(ABORT, 'transfer_leg_missing')
    WHERE NOT EXISTS (SELECT 1 FROM transactions WHERE link_group = NEW.link_group AND id <> NEW.id AND amount_cents = -NEW.amount_cents);
  INSERT INTO transaction_links (uuid, link_type, from_transaction_id, to_transaction_id, amount_cents, status, decided_by, created_at)
  SELECT lower(hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-4' || substr(hex(randomblob(2)), 2) || '-' ||
      substr('89ab', 1 + (abs(random()) % 4), 1) || substr(hex(randomblob(2)), 2) || '-' || hex(randomblob(6))),
    COALESCE(NEW.link_hint, 'transfer'),
    (SELECT id FROM transactions WHERE link_group = NEW.link_group AND id <> NEW.id AND amount_cents = -NEW.amount_cents ORDER BY id LIMIT 1),
    NEW.id, NEW.amount_cents, 'confirmed', 'user', strftime('%Y-%m-%dT%H:%M:%fZ', 'now');
END;

-- A refund names its original expense; the INSERT aborts if the refunds would exceed the expense (I-15).
CREATE TRIGGER IF NOT EXISTS transactions_link_refund AFTER INSERT ON transactions
WHEN NEW.link_hint = 'refund_of' AND NEW.link_target_id IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'refund_target_invalid')
    WHERE NOT EXISTS (SELECT 1 FROM transactions WHERE id = NEW.link_target_id AND amount_cents < 0 AND deleted_at IS NULL);
  SELECT RAISE(ABORT, 'refund_too_large')
    WHERE NEW.amount_cents + COALESCE((SELECT SUM(l.amount_cents) FROM transaction_links l JOIN transactions r ON r.id = l.from_transaction_id
      WHERE l.link_type = 'refund_of' AND l.to_transaction_id = NEW.link_target_id AND l.status = 'confirmed' AND r.deleted_at IS NULL), 0)
      > -(SELECT amount_cents FROM transactions WHERE id = NEW.link_target_id);
  INSERT INTO transaction_links (uuid, link_type, from_transaction_id, to_transaction_id, amount_cents, status, decided_by, created_at)
  VALUES (lower(hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-4' || substr(hex(randomblob(2)), 2) || '-' ||
      substr('89ab', 1 + (abs(random()) % 4), 1) || substr(hex(randomblob(2)), 2) || '-' || hex(randomblob(6))),
    'refund_of', NEW.id, NEW.link_target_id, NEW.amount_cents, 'confirmed', 'user', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;

-- Backfill, reproducing today's totals.
UPDATE transactions SET
  uuid = lower(hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-4' || substr(hex(randomblob(2)), 2) || '-' ||
    substr('89ab', 1 + (abs(random()) % 4), 1) || substr(hex(randomblob(2)), 2) || '-' || hex(randomblob(6))),
  original_description = description,
  kind = CASE WHEN category = 'Transfers' THEN 'transfer' WHEN amount_cents > 0 THEN 'income' ELSE 'expense' END,
  entry_origin = CASE WHEN remote_id IS NOT NULL THEN 'web_copy' ELSE 'import' END
WHERE uuid IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS index_transactions_on_uuid ON transactions (uuid);

-- One account per imported account key, plus one for rows whose account was never known.
INSERT INTO accounts (uuid, name, account_type, currency, institution, last4, account_key, opening_balance_source, created_at, updated_at)
SELECT lower(hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-4' || substr(hex(randomblob(2)), 2) || '-' ||
    substr('89ab', 1 + (abs(random()) % 4), 1) || substr(hex(randomblob(2)), 2) || '-' || hex(randomblob(6))),
  substr(COALESCE(NULLIF(trim(COALESCE(institution, '') || CASE WHEN last4 IS NOT NULL THEN ' …' || last4 ELSE '' END), ''), 'Account'), 1, 60),
  CASE kind WHEN 'checking' THEN 'checking' WHEN 'savings' THEN 'savings' WHEN 'credit_card' THEN 'credit_card' WHEN 'loan' THEN 'loan' ELSE 'other' END,
  currency, institution, last4, account_key, 'unknown', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM (SELECT account_key, MAX(institution) AS institution, MAX(account_last4) AS last4, MAX(account_kind) AS kind, MAX(currency) AS currency
      FROM statements WHERE account_key IS NOT NULL GROUP BY account_key);
INSERT INTO accounts (uuid, name, account_type, currency, account_key, opening_balance_source, created_at, updated_at)
SELECT lower(hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-4' || substr(hex(randomblob(2)), 2) || '-' ||
    substr('89ab', 1 + (abs(random()) % 4), 1) || substr(hex(randomblob(2)), 2) || '-' || hex(randomblob(6))),
  'Imported (no account)', 'other', (SELECT currency FROM statements LIMIT 1), '__unassigned__', 'unknown',
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE EXISTS (SELECT 1 FROM statements WHERE account_key IS NULL);

UPDATE statements SET account_id = (SELECT id FROM accounts WHERE accounts.account_key = COALESCE(statements.account_key, '__unassigned__'))
WHERE account_id IS NULL;
UPDATE transactions SET account_id = COALESCE(
  (SELECT id FROM accounts WHERE accounts.account_key = transactions.account_key),
  (SELECT account_id FROM statements WHERE statements.id = transactions.statement_id))
WHERE account_id IS NULL;
CREATE INDEX IF NOT EXISTS index_transactions_on_account ON transactions (account_id, booked_on);
CREATE INDEX IF NOT EXISTS index_transactions_on_kind ON transactions (kind);
CREATE INDEX IF NOT EXISTS index_transactions_on_deleted ON transactions (deleted_at) WHERE deleted_at IS NOT NULL;

-- Asset accounts with an imported closing balance get the opening balance that makes the
-- balance on that date equal the statement (opening = closing - Σ rows up to that date).
-- Credit-card statements print balances with issuer-specific signs, so they stay at 0 ('unknown')
-- until the person sets the real balance ("Adjust balance").
UPDATE accounts SET
  opening_balance_cents = (
    SELECT s.closing_balance_cents - COALESCE((SELECT SUM(t.amount_cents) FROM transactions t WHERE t.account_id = accounts.id AND t.booked_on <= s.closing_balance_on), 0)
    FROM statements s WHERE s.account_id = accounts.id AND s.closing_balance_cents IS NOT NULL AND s.closing_balance_on IS NOT NULL
    ORDER BY s.closing_balance_on DESC, s.id DESC LIMIT 1),
  opening_balance_source = 'statement'
WHERE account_type IN ('checking', 'savings', 'other') AND account_key <> '__unassigned__'
  AND EXISTS (SELECT 1 FROM statements s WHERE s.account_id = accounts.id AND s.closing_balance_cents IS NOT NULL AND s.closing_balance_on IS NOT NULL);
