-- Version 2: copies of statements from the BillieWeather website.
-- Adds columns only; every existing row keeps its data (existing statements become source 'local').
ALTER TABLE statements ADD COLUMN source TEXT NOT NULL DEFAULT 'local' CHECK (source IN ('local', 'web'));
ALTER TABLE statements ADD COLUMN remote_id INTEGER;
CREATE UNIQUE INDEX IF NOT EXISTS index_statements_on_remote_id ON statements (remote_id) WHERE remote_id IS NOT NULL;

ALTER TABLE transactions ADD COLUMN remote_id INTEGER;
-- Set when the person changes a category or exclusion on this device, so a later download
-- from the website does not overwrite their choice.
ALTER TABLE transactions ADD COLUMN locally_modified INTEGER NOT NULL DEFAULT 0 CHECK (locally_modified IN (0, 1));
CREATE UNIQUE INDEX IF NOT EXISTS index_transactions_on_remote_id ON transactions (remote_id) WHERE remote_id IS NOT NULL;
