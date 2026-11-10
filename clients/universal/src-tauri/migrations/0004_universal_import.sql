-- Version 4: BillieWeather Financial Data Schema v1 (universal import).
-- Additive only: new nullable/defaulted columns and new tables. No existing row or value is
-- changed except filling the new columns of existing rows from data they already have.
--
-- Rollback: older app versions cannot open a database after this migration (the migration
-- runner refuses unknown versions), so there is no in-app downgrade. Every pre-existing column
-- keeps its meaning and values; the added columns can be removed manually with
-- ALTER TABLE ... DROP COLUMN (SQLite 3.35+) and DROP TABLE/TRIGGER for the new objects.

-- Statements: where they came from and what the import decided.
ALTER TABLE statements ADD COLUMN import_batch_id TEXT;
ALTER TABLE statements ADD COLUMN source_sha256 TEXT;
ALTER TABLE statements ADD COLUMN source_format TEXT;
ALTER TABLE statements ADD COLUMN account_key TEXT;
ALTER TABLE statements ADD COLUMN institution TEXT;
ALTER TABLE statements ADD COLUMN account_last4 TEXT;
ALTER TABLE statements ADD COLUMN account_kind TEXT NOT NULL DEFAULT 'unknown';
ALTER TABLE statements ADD COLUMN opening_balance_cents INTEGER;
ALTER TABLE statements ADD COLUMN opening_balance_on TEXT;
-- JSON summary: rows read, accepted, duplicates skipped, rejected rows with reasons, conventions used.
ALTER TABLE statements ADD COLUMN import_report TEXT;
UPDATE statements SET source_sha256 = sha256 WHERE source_sha256 IS NULL;
CREATE INDEX IF NOT EXISTS index_statements_on_source_sha256 ON statements (source_sha256);
CREATE INDEX IF NOT EXISTS index_statements_on_import_batch_id ON statements (import_batch_id);

-- Transactions: canonical fields. amount_cents keeps its meaning (fixed scale 2, sign = cash flow).
ALTER TABLE transactions ADD COLUMN posted_on TEXT;
ALTER TABLE transactions ADD COLUMN normalized_merchant TEXT;
ALTER TABLE transactions ADD COLUMN currency TEXT;
ALTER TABLE transactions ADD COLUMN direction TEXT CHECK (direction IS NULL OR direction IN ('debit', 'credit', 'zero'));
ALTER TABLE transactions ADD COLUMN balance_cents INTEGER;
ALTER TABLE transactions ADD COLUMN bank_reference TEXT;
ALTER TABLE transactions ADD COLUMN account_key TEXT;
ALTER TABLE transactions ADD COLUMN category_source TEXT NOT NULL DEFAULT 'legacy';
ALTER TABLE transactions ADD COLUMN pending INTEGER NOT NULL DEFAULT 0 CHECK (pending IN (0, 1));
ALTER TABLE transactions ADD COLUMN kind_hints TEXT;
ALTER TABLE transactions ADD COLUMN source_ref TEXT;
ALTER TABLE transactions ADD COLUMN parse_confidence INTEGER CHECK (parse_confidence IS NULL OR parse_confidence BETWEEN 0 AND 100);
-- 'legacy' (imported before v4), 'verified' (read cleanly), 'user_confirmed' (a person reviewed or edited it).
ALTER TABLE transactions ADD COLUMN validation_status TEXT NOT NULL DEFAULT 'legacy';
-- Original cell values as JSON, for audits and corrections.
ALTER TABLE transactions ADD COLUMN source_raw TEXT;
UPDATE transactions SET
  currency = (SELECT currency FROM statements WHERE statements.id = transactions.statement_id),
  direction = CASE WHEN amount_cents < 0 THEN 'debit' WHEN amount_cents > 0 THEN 'credit' ELSE 'zero' END
WHERE currency IS NULL;
-- Categories a person changed on this device stay theirs.
UPDATE transactions SET category_source = 'user' WHERE locally_modified = 1;
CREATE INDEX IF NOT EXISTS index_transactions_on_bank_reference ON transactions (bank_reference) WHERE bank_reference IS NOT NULL;
CREATE INDEX IF NOT EXISTS index_transactions_on_dedupe ON transactions (booked_on, amount_cents);

-- Rows of an import that is being committed. Invisible to every reader of `transactions`.
CREATE TABLE IF NOT EXISTS import_staging_rows (
  staging_key TEXT NOT NULL,
  position INTEGER NOT NULL,
  booked_on TEXT NOT NULL,
  description TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  category TEXT NOT NULL,
  tax_review INTEGER NOT NULL,
  posted_on TEXT,
  normalized_merchant TEXT,
  currency TEXT NOT NULL,
  direction TEXT NOT NULL,
  balance_cents INTEGER,
  bank_reference TEXT,
  account_key TEXT,
  category_source TEXT NOT NULL,
  pending INTEGER NOT NULL,
  kind_hints TEXT,
  source_ref TEXT,
  parse_confidence INTEGER,
  validation_status TEXT NOT NULL,
  source_raw TEXT,
  staged_at TEXT NOT NULL,
  PRIMARY KEY (staging_key, position)
);

-- Atomic commit. The app stages rows, then inserts the statement: this trigger moves the staged
-- rows into `transactions` inside that single INSERT statement, so the statement and all of its
-- transactions appear together or not at all, even with a pooled connection and even if the app
-- is killed. A count mismatch aborts the whole INSERT.
CREATE TRIGGER IF NOT EXISTS statements_commit_staged AFTER INSERT ON statements
WHEN NEW.import_batch_id IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'import_incomplete')
    WHERE (SELECT COUNT(*) FROM import_staging_rows WHERE staging_key = NEW.sha256) <> NEW.transaction_count;
  INSERT INTO transactions (statement_id, booked_on, description, amount_cents, category, tax_review, excluded, updated_at,
    posted_on, normalized_merchant, currency, direction, balance_cents, bank_reference, account_key, category_source, pending,
    kind_hints, source_ref, parse_confidence, validation_status, source_raw)
  SELECT NEW.id, booked_on, description, amount_cents, category, tax_review, 0, NEW.imported_at,
    posted_on, normalized_merchant, currency, direction, balance_cents, bank_reference, account_key, category_source, pending,
    kind_hints, source_ref, parse_confidence, validation_status, source_raw
  FROM import_staging_rows WHERE staging_key = NEW.sha256 ORDER BY position;
  DELETE FROM import_staging_rows WHERE staging_key = NEW.sha256;
  INSERT OR IGNORE INTO settings (key, value) VALUES ('currency', NEW.currency);
END;

-- Reusable bank-specific column mappings.
CREATE TABLE IF NOT EXISTS import_templates (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  institution TEXT,
  fingerprint TEXT NOT NULL,
  -- JSON: the template (headers, field -> header, conventions).
  body TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS index_import_templates_on_fingerprint ON import_templates (fingerprint);
