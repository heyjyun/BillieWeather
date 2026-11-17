-- Version 9: closes a gap in version 8's refund guard and tidies derived link data.
-- No amount, date, description, category, kind or account of any entry is changed.
--
-- 1. Insert-time helpers. `link_group`, `link_hint` and `link_target_id` exist only so that one
--    INSERT can create an entry together with its link (version 7). They carry no information once
--    the INSERT has finished, and the app cleared them with a second statement. If the app was
--    killed between those two statements the helpers stayed. Version 8's refund guard skipped every
--    row whose `link_hint` was 'refund_of', so such a row was never checked again: restoring it from
--    the trash, or raising its amount, could put more refunds on an expense than the expense itself.
--    From now on the app writes the entry and clears the helpers in one transaction; this migration
--    clears what older versions may have left and makes the guard independent of leftovers.
UPDATE transactions SET link_group = NULL, link_hint = NULL, link_target_id = NULL
WHERE link_group IS NOT NULL OR link_hint IS NOT NULL OR link_target_id IS NOT NULL;

-- The guard is skipped only by the UPDATE that itself asks for a new refund link (the helper goes
-- from empty to 'refund_of' in that same statement; `transactions_refund_relink` and
-- `transaction_links_refund_guard` then validate the new link). A helper that was already set is
-- no reason to skip the check.
DROP TRIGGER IF EXISTS transactions_refund_update_guard;
CREATE TRIGGER transactions_refund_update_guard BEFORE UPDATE OF amount_cents, kind, deleted_at ON transactions
WHEN NEW.kind = 'refund' AND NEW.deleted_at IS NULL AND NOT (NEW.link_hint IS 'refund_of' AND OLD.link_hint IS NULL)
BEGIN
  SELECT RAISE(ABORT, 'refund_too_large') WHERE EXISTS (
    SELECT 1 FROM transaction_links own JOIN transactions expense ON expense.id = own.to_transaction_id
    WHERE own.link_type = 'refund_of' AND own.status = 'confirmed' AND own.from_transaction_id = OLD.id AND
      (expense.kind <> 'expense' OR NEW.amount_cents <= 0 OR NEW.amount_cents + COALESCE((
        SELECT SUM(r.amount_cents) FROM transaction_links l JOIN transactions r ON r.id = l.from_transaction_id
        WHERE l.link_type = 'refund_of' AND l.status = 'confirmed' AND l.to_transaction_id = expense.id
          AND r.deleted_at IS NULL AND r.id <> OLD.id), 0) > -expense.amount_cents)
  );
END;

-- 2. A refund link's amount is derived: it is the refund's own amount (version 8 keeps the two in
--    step on every later edit, but did not touch links written before it). Bring older links in
--    line, so "how much of this expense can still be refunded" reads the same from either side.
UPDATE transaction_links SET amount_cents = (SELECT r.amount_cents FROM transactions r WHERE r.id = transaction_links.from_transaction_id)
WHERE link_type = 'refund_of' AND EXISTS (
  SELECT 1 FROM transactions r WHERE r.id = transaction_links.from_transaction_id AND r.kind = 'refund' AND r.amount_cents > 0
    AND r.amount_cents IS NOT transaction_links.amount_cents);

-- 3. Lookups the app runs on every screen and every import.
--    Entries of a statement, newest first (statement pages, reverse import); duplicate detection
--    reads imported live rows by date; the trash and the operation log read by time.
CREATE INDEX IF NOT EXISTS index_transactions_on_live_booked ON transactions (booked_on DESC, id DESC) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS index_transaction_links_on_from ON transaction_links (from_transaction_id);
CREATE INDEX IF NOT EXISTS index_transaction_tags_on_tag ON transaction_tags (tag_id);
CREATE INDEX IF NOT EXISTS index_statements_on_account ON statements (account_id);
