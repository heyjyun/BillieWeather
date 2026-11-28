import type { FinanceStore } from "./store";

export type StatementObservation = {id:number; filename:string; day:string; cents:number};
// Only the latest dated cash statement may offer a balance. An undated or newer
// incomplete statement prevents the older observation from appearing current.
export function statementObservations(store: FinanceStore, today: string) {
  return store.sql.select<StatementObservation>(`
    WITH dated AS (
      SELECT s.*,COALESCE(s.closing_balance_on,(SELECT MAX(t.booked_on) FROM transactions t WHERE t.statement_id=s.id)) AS observed
      FROM statements s WHERE s.account_id IS NOT NULL
    ), ranked AS (
      SELECT dated.*,ROW_NUMBER() OVER (PARTITION BY account_id ORDER BY observed IS NULL DESC,observed DESC,id DESC) AS rank FROM dated
    )
    SELECT a.id,r.filename,r.closing_balance_on AS day,r.closing_balance_cents AS cents
    FROM ranked r JOIN accounts a ON a.id=r.account_id WHERE rank=1 AND a.archived_at IS NULL AND a.account_type IN ('checking','savings')
    AND r.currency=a.currency AND r.closing_balance_cents IS NOT NULL AND r.closing_balance_on=r.observed AND r.observed<=?
    AND (a.balance_snapshot=0 OR a.opening_balance_on<=r.observed)
    AND (a.opening_balance_source='unknown' OR r.closing_balance_cents<>a.opening_balance_cents+
      (SELECT COALESCE(SUM(t.amount_cents),0) FROM transactions t WHERE t.account_id=a.id AND t.deleted_at IS NULL
      AND t.booked_on<=r.observed AND (a.balance_snapshot=0 OR t.booked_on>a.opening_balance_on)))`,[today]);
}
