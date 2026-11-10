-- Version 5: optional country / region of a statement, chosen by the person on the Import page.
-- Additive only: one nullable column. Existing statements keep every value and read as
-- "not specified" (NULL). The value is a two-letter code validated by the app (finance-core
-- regions.ts); it is context for rule-based categorization and never changes amounts, dates,
-- currency, balances or duplicate detection. It stays in this file on the device.
ALTER TABLE statements ADD COLUMN region TEXT;
