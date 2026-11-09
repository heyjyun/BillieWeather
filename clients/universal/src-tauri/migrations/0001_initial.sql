-- BillieWeather local database, version 1. Lives in the app's private data directory.
-- Money is integer cents. Never add statements that drop or rewrite user data here:
-- later versions must ship as new numbered files (0002_..., 0003_...) that migrate in place.
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY NOT NULL,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS statements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  filename TEXT NOT NULL,
  currency TEXT NOT NULL,
  sha256 TEXT NOT NULL UNIQUE,
  transaction_count INTEGER NOT NULL,
  closing_balance_cents INTEGER,
  closing_balance_on TEXT,
  imported_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS transactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  statement_id INTEGER NOT NULL REFERENCES statements(id) ON DELETE CASCADE,
  booked_on TEXT NOT NULL,
  description TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  category TEXT NOT NULL CHECK (category IN ('Income','Housing','Food & dining','Transport','Utilities','Shopping','Health','Business','Transfers','Uncategorized')),
  tax_review INTEGER NOT NULL DEFAULT 0 CHECK (tax_review IN (0, 1)),
  excluded INTEGER NOT NULL DEFAULT 0 CHECK (excluded IN (0, 1)),
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS index_transactions_on_booked_on ON transactions (booked_on);
CREATE INDEX IF NOT EXISTS index_transactions_on_statement_id ON transactions (statement_id);

CREATE TABLE IF NOT EXISTS merchant_rules (
  merchant_key TEXT NOT NULL,
  income INTEGER NOT NULL CHECK (income IN (0, 1)),
  category TEXT NOT NULL CHECK (category IN ('Income','Housing','Food & dining','Transport','Utilities','Shopping','Health','Business','Transfers')),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (merchant_key, income)
);
