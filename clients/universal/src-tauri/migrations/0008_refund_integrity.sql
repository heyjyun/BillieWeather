-- Refund limits must survive edits, trash restoration and concurrent pooled writes, not just INSERT.
-- Do not rewrite existing financial data: enforce integrity on subsequent writes.
CREATE TRIGGER transactions_refund_expense_guard BEFORE UPDATE OF amount_cents, kind ON transactions
WHEN EXISTS (
  SELECT 1 FROM transaction_links l JOIN transactions r ON r.id = l.from_transaction_id
  WHERE l.link_type = 'refund_of' AND l.status = 'confirmed' AND l.to_transaction_id = OLD.id AND r.deleted_at IS NULL
)
BEGIN
  SELECT RAISE(ABORT, 'refund_too_large') WHERE NEW.kind <> 'expense' OR NEW.amount_cents >= 0 OR
    -NEW.amount_cents < (SELECT SUM(r.amount_cents) FROM transaction_links l JOIN transactions r ON r.id = l.from_transaction_id
      WHERE l.link_type = 'refund_of' AND l.status = 'confirmed' AND l.to_transaction_id = OLD.id AND r.deleted_at IS NULL);
END;

CREATE TRIGGER transactions_refund_update_guard BEFORE UPDATE OF amount_cents, kind, deleted_at ON transactions
WHEN NEW.kind = 'refund' AND NEW.deleted_at IS NULL AND COALESCE(NEW.link_hint, '') <> 'refund_of'
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

CREATE TRIGGER transaction_links_refund_guard BEFORE INSERT ON transaction_links
WHEN NEW.link_type = 'refund_of' AND NEW.status = 'confirmed'
BEGIN
  SELECT RAISE(ABORT, 'refund_target_invalid') WHERE EXISTS (
    SELECT 1 FROM transaction_links WHERE link_type = 'refund_of' AND status = 'confirmed' AND from_transaction_id = NEW.from_transaction_id
  );
  SELECT RAISE(ABORT, 'refund_target_invalid') WHERE NOT EXISTS (
    SELECT 1 FROM transactions r JOIN transactions e ON e.id = NEW.to_transaction_id
    WHERE r.id = NEW.from_transaction_id AND r.kind = 'refund' AND r.amount_cents > 0
      AND NEW.amount_cents = r.amount_cents AND e.kind = 'expense' AND e.amount_cents < 0
  );
  SELECT RAISE(ABORT, 'refund_too_large') WHERE EXISTS (
    SELECT 1 FROM transactions r JOIN transactions e ON e.id = NEW.to_transaction_id
    WHERE r.id = NEW.from_transaction_id AND r.deleted_at IS NULL AND r.amount_cents + COALESCE((
      SELECT SUM(other.amount_cents) FROM transaction_links l JOIN transactions other ON other.id = l.from_transaction_id
      WHERE l.link_type = 'refund_of' AND l.status = 'confirmed' AND l.to_transaction_id = e.id AND other.deleted_at IS NULL), 0) > -e.amount_cents
  );
END;

CREATE TRIGGER transactions_refund_sync_link AFTER UPDATE OF amount_cents, kind ON transactions
BEGIN
  DELETE FROM transaction_links WHERE from_transaction_id = NEW.id AND link_type = 'refund_of' AND NEW.kind <> 'refund';
  UPDATE transaction_links SET amount_cents = NEW.amount_cents WHERE from_transaction_id = NEW.id AND link_type = 'refund_of' AND NEW.kind = 'refund';
END;

-- A refund edit/reclassification and its new relation commit in the same statement. Failure in
-- any link guard rolls back the entry edit as well, including its prior link.
CREATE TRIGGER transactions_refund_relink AFTER UPDATE OF link_hint, link_target_id ON transactions
WHEN NEW.link_hint = 'refund_of'
BEGIN
  DELETE FROM transaction_links WHERE from_transaction_id = NEW.id AND link_type = 'refund_of';
  INSERT INTO transaction_links (uuid, link_type, from_transaction_id, to_transaction_id, amount_cents, status, decided_by, created_at)
    SELECT lower(hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-4' || substr(hex(randomblob(2)), 2) || '-' ||
      substr('89ab', 1 + (abs(random()) % 4), 1) || substr(hex(randomblob(2)), 2) || '-' || hex(randomblob(6))),
      'refund_of', NEW.id, NEW.link_target_id, NEW.amount_cents, 'confirmed',
      CASE WHEN NEW.category_source IN ('ai', 'rule') THEN NEW.category_source ELSE 'user' END, NEW.updated_at
    WHERE NEW.kind = 'refund' AND NEW.link_target_id IS NOT NULL;
  UPDATE transactions SET link_hint = NULL, link_target_id = NULL WHERE id = NEW.id;
END;
