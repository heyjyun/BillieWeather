-- Dated balances reviewed in account capture and reconciliation are end-of-day snapshots.
-- Extend both undo images in place so older manual edits can still be replayed.
ALTER TABLE accounts ADD COLUMN balance_snapshot INTEGER NOT NULL DEFAULT 0 CHECK(balance_snapshot IN (0,1));
UPDATE history_changes SET
  before_image = CASE WHEN before_image IS NOT NULL THEN json_set(before_image,'$.balance_snapshot',0) END,
  after_image = CASE WHEN after_image IS NOT NULL THEN json_set(after_image,'$.balance_snapshot',0) END
WHERE table_name = 'accounts';
DROP TRIGGER history_accounts_update;
DROP TRIGGER history_accounts_delete;
CREATE TRIGGER history_accounts_update BEFORE UPDATE ON accounts
WHEN (SELECT group_id FROM history_state WHERE id = 1) IS NOT NULL
BEGIN
  INSERT INTO history_changes (group_id, table_name, row_key, before_image)
    SELECT (SELECT group_id FROM history_state WHERE id = 1), 'accounts', json_array(OLD.id), json_object('id', OLD.id, 'uuid', OLD.uuid, 'name', OLD.name, 'account_type', OLD.account_type, 'currency', OLD.currency, 'institution', OLD.institution, 'last4', OLD.last4, 'account_key', OLD.account_key, 'opening_balance_cents', OLD.opening_balance_cents, 'opening_balance_on', OLD.opening_balance_on, 'opening_balance_source', OLD.opening_balance_source, 'credit_limit_cents', OLD.credit_limit_cents, 'statement_day', OLD.statement_day, 'due_day', OLD.due_day, 'include_in_net_worth', OLD.include_in_net_worth, 'note', OLD.note, 'sort_order', OLD.sort_order, 'archived_at', OLD.archived_at, 'created_at', OLD.created_at, 'balance_snapshot', OLD.balance_snapshot)
    WHERE NOT EXISTS (SELECT 1 FROM history_changes WHERE group_id = (SELECT group_id FROM history_state WHERE id = 1) AND table_name = 'accounts' AND row_key = json_array(OLD.id));
END;
CREATE TRIGGER history_accounts_delete BEFORE DELETE ON accounts
WHEN (SELECT group_id FROM history_state WHERE id = 1) IS NOT NULL
BEGIN
  INSERT INTO history_changes (group_id, table_name, row_key, before_image)
    SELECT (SELECT group_id FROM history_state WHERE id = 1), 'accounts', json_array(OLD.id), json_object('id', OLD.id, 'uuid', OLD.uuid, 'name', OLD.name, 'account_type', OLD.account_type, 'currency', OLD.currency, 'institution', OLD.institution, 'last4', OLD.last4, 'account_key', OLD.account_key, 'opening_balance_cents', OLD.opening_balance_cents, 'opening_balance_on', OLD.opening_balance_on, 'opening_balance_source', OLD.opening_balance_source, 'credit_limit_cents', OLD.credit_limit_cents, 'statement_day', OLD.statement_day, 'due_day', OLD.due_day, 'include_in_net_worth', OLD.include_in_net_worth, 'note', OLD.note, 'sort_order', OLD.sort_order, 'archived_at', OLD.archived_at, 'created_at', OLD.created_at, 'balance_snapshot', OLD.balance_snapshot)
    WHERE NOT EXISTS (SELECT 1 FROM history_changes WHERE group_id = (SELECT group_id FROM history_state WHERE id = 1) AND table_name = 'accounts' AND row_key = json_array(OLD.id));
END;
