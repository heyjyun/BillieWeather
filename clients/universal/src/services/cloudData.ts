// The person's BillieWeather cloud database, for the Data page: what is in it (counts,
// dates, approximate size, the list of statements) and deleting ONE statement at a time.
// Sends no request body at all and imports no financial code (enforced by
// test/privacy.test.ts). There is deliberately no "delete everything" call.
import { API_ORIGIN, AccountError } from "./account";

const FINANCE = `${API_ORIGIN}/api/client/v1/finance`;

export interface CloudSummary {
  currency: string | null;
  /** The name the person gave the cloud database, or null (the default name is shown). */
  name: string | null;
  statements: number;
  transactions: number;
  rules: number;
  bankAccounts: number;
  pendingImports: number;
  insights: number;
  lastUpdatedAt: string | null;
  periodStart: string | null;
  periodEnd: string | null;
  storageBytes: number;
}

export interface CloudStatement {
  id: number;
  filename: string;
  sha256: string;
  transactionCount: number;
  periodStart: string | null;
  periodEnd: string | null;
  importedAt: string;
}

async function call(path: string, method: "GET" | "DELETE", token: string): Promise<Record<string, unknown>> {
  let response: Response;
  try {
    response = await fetch(`${FINANCE}${path}`, {
      method,
      headers: { Accept: "application/json", Authorization: `Bearer ${token}` },
      credentials: "omit",
      cache: "no-store",
    });
  } catch {
    throw new AccountError("offline");
  }
  const json = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (response.status === 401) throw new AccountError("unauthorized");
  if (response.status === 429) throw new AccountError("rate_limited");
  if (!response.ok) throw new AccountError("unknown");
  return json;
}

export async function fetchCloudSummary(token: string): Promise<CloudSummary> {
  const json = await call("", "GET", token);
  const n = (key: string) => Number(json[key] ?? 0);
  const text = (key: string) => (json[key] as string | null | undefined) ?? null;
  return {
    currency: text("currency"), name: text("name"), statements: n("statement_count"), transactions: n("transaction_count"), rules: n("rule_count"),
    bankAccounts: n("bank_account_count"), pendingImports: n("pending_import_count"), insights: n("insight_count"),
    lastUpdatedAt: text("last_updated_at"), periodStart: text("period_start"), periodEnd: text("period_end"), storageBytes: n("storage_bytes"),
  };
}

export async function fetchCloudStatements(token: string): Promise<CloudStatement[]> {
  const json = await call("/statements", "GET", token);
  return ((json.statements as Array<Record<string, unknown>>) ?? []).map((row) => ({
    id: Number(row.id), filename: String(row.filename), sha256: String(row.sha256), transactionCount: Number(row.transaction_count),
    periodStart: (row.period_start as string | null) ?? null, periodEnd: (row.period_end as string | null) ?? null, importedAt: String(row.imported_at),
  }));
}

/** Deletes one statement and its transactions from the cloud. */
export async function deleteCloudStatement(token: string, id: number): Promise<void> {
  await call(`/statements/${Math.trunc(id)}`, "DELETE", token);
}
