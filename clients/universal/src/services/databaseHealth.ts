// Settings › Database › Check integrity. Read-only: SQLite's own integrity check of the database file,
// plus a check that every foreign key points at an existing row (the same assertion backup.ts makes
// after a restore). It never writes, repairs or deletes anything.
import type { SqlDriver } from "./store";

export interface DatabaseHealth {
  ok: boolean;
  /** Problems reported by SQLite (integrity) plus rows with a broken link (foreign keys). */
  problems: number;
  /** The first few messages from SQLite, for support. Never contains financial values. */
  details: string[];
}

const MAX_DETAILS = 20;

export async function checkDatabase(sql: SqlDriver): Promise<DatabaseHealth> {
  const integrity = await sql.select<{ result: string }>(`SELECT integrity_check AS result FROM pragma_integrity_check LIMIT ${MAX_DETAILS}`);
  const messages = integrity.map((row) => String(row.result)).filter((text) => text !== "ok");
  const [links] = await sql.select<{ n: number }>("SELECT COUNT(*) AS n FROM pragma_foreign_key_check");
  const broken = Number(links?.n ?? 0);
  const details = [...messages, ...(broken > 0 ? [`foreign_key_check: ${broken}`] : [])].slice(0, MAX_DETAILS);
  const problems = messages.length + broken;
  return { ok: problems === 0, problems, details };
}
