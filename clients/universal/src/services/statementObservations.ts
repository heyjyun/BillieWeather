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

export type AccountEvidence = { id: number; lastEntryOn: string | null; lastAdjustmentOn: string | null; statementOn: string | null; statementMatches: boolean; imported: boolean };
// Dates behind each account's balance, for the Accounts table. Read-only. A statement confirms a
// balance only when the latest dated statement (same rule as above) equals the ledger on its date.
export async function accountEvidence(store: FinanceStore, today: string): Promise<Map<number, AccountEvidence>> {
  const dates = await store.sql.select<{ id: number; last_entry_on: string | null; last_adjustment_on: string | null; imported: number }>(`
    SELECT a.id,
      (SELECT MAX(t.booked_on) FROM transactions t WHERE t.account_id=a.id AND t.deleted_at IS NULL) AS last_entry_on,
      (SELECT MAX(t.booked_on) FROM transactions t WHERE t.account_id=a.id AND t.deleted_at IS NULL AND t.kind='adjustment' AND t.booked_on<=?) AS last_adjustment_on,
      EXISTS(SELECT 1 FROM statements s WHERE s.account_id=a.id AND COALESCE(s.source_format,'')<>'manual') AS imported
    FROM accounts a`, [today]);
  const statements = await store.sql.select<{ id: number; day: string; matches: number }>(`
    WITH dated AS (
      SELECT s.*,COALESCE(s.closing_balance_on,(SELECT MAX(t.booked_on) FROM transactions t WHERE t.statement_id=s.id)) AS observed
      FROM statements s WHERE s.account_id IS NOT NULL
    ), ranked AS (
      SELECT dated.*,ROW_NUMBER() OVER (PARTITION BY account_id ORDER BY observed IS NULL DESC,observed DESC,id DESC) AS rank FROM dated
    )
    SELECT a.id,r.closing_balance_on AS day,
      CASE WHEN r.closing_balance_cents=a.opening_balance_cents+(SELECT COALESCE(SUM(t.amount_cents),0) FROM transactions t WHERE t.account_id=a.id AND t.deleted_at IS NULL
        AND t.booked_on<=r.observed AND (a.balance_snapshot=0 OR t.booked_on>a.opening_balance_on)) THEN 1 ELSE 0 END AS matches
    FROM ranked r JOIN accounts a ON a.id=r.account_id WHERE rank=1 AND a.account_type IN ('checking','savings')
    AND r.currency=a.currency AND r.closing_balance_cents IS NOT NULL AND r.closing_balance_on=r.observed AND r.observed<=?
    AND a.opening_balance_source<>'unknown' AND (a.balance_snapshot=0 OR a.opening_balance_on<=r.observed)`, [today]);
  const byId = new Map(statements.map((row) => [Number(row.id), row]));
  return new Map(dates.map((row) => {
    const statement = byId.get(Number(row.id));
    return [Number(row.id), { id: Number(row.id), lastEntryOn: row.last_entry_on, lastAdjustmentOn: row.last_adjustment_on,
      statementOn: statement?.day ?? null, statementMatches: Number(statement?.matches) === 1, imported: Number(row.imported) === 1 }];
  }));
}
