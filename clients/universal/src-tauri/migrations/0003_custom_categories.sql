-- Version 3: categories the person creates. SQLite can't drop a CHECK constraint, so the two
-- tables whose category column only allowed the built-in names are rebuilt with every row,
-- column and index kept. Category names are still checked by the app (packages/finance-core).
CREATE TABLE IF NOT EXISTS custom_categories (
  name TEXT PRIMARY KEY NOT NULL COLLATE NOCASE CHECK (length(name) BETWEEN 1 AND 40),
  created_at TEXT NOT NULL
);

CREATE TABLE transactions_v3 (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  statement_id INTEGER NOT NULL REFERENCES statements(id) ON DELETE CASCADE,
  booked_on TEXT NOT NULL,
  description TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  category TEXT NOT NULL CHECK (length(category) BETWEEN 1 AND 40),
  tax_review INTEGER NOT NULL DEFAULT 0 CHECK (tax_review IN (0, 1)),
  excluded INTEGER NOT NULL DEFAULT 0 CHECK (excluded IN (0, 1)),
  updated_at TEXT NOT NULL,
  remote_id INTEGER,
  locally_modified INTEGER NOT NULL DEFAULT 0 CHECK (locally_modified IN (0, 1))
);
INSERT INTO transactions_v3 (id, statement_id, booked_on, description, amount_cents, category, tax_review, excluded, updated_at, remote_id, locally_modified)
  SELECT id, statement_id, booked_on, description, amount_cents, category, tax_review, excluded, updated_at, remote_id, locally_modified FROM transactions;
DROP TABLE transactions;
ALTER TABLE transactions_v3 RENAME TO transactions;
CREATE INDEX IF NOT EXISTS index_transactions_on_booked_on ON transactions (booked_on);
CREATE INDEX IF NOT EXISTS index_transactions_on_statement_id ON transactions (statement_id);
CREATE UNIQUE INDEX IF NOT EXISTS index_transactions_on_remote_id ON transactions (remote_id) WHERE remote_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS index_transactions_on_category ON transactions (category);

CREATE TABLE merchant_rules_v3 (
  merchant_key TEXT NOT NULL,
  income INTEGER NOT NULL CHECK (income IN (0, 1)),
  category TEXT NOT NULL CHECK (length(category) BETWEEN 1 AND 40 AND category <> 'Uncategorized'),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (merchant_key, income)
);
INSERT INTO merchant_rules_v3 (merchant_key, income, category, updated_at) SELECT merchant_key, income, category, updated_at FROM merchant_rules;
DROP TABLE merchant_rules;
ALTER TABLE merchant_rules_v3 RENAME TO merchant_rules;
