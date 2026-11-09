// Downloads (read-only) the person's financial data from their BillieWeather web account so
// it can be copied into this device's database. Only GET requests and never a request body;
// nothing on this device is uploaded (enforced by test/privacy.test.ts).
import type { Category, Currency, MerchantRule } from "@billie/shared-types";
import { decimalToCents } from "@billie/finance-core";
import { API_ORIGIN, AccountError } from "./account";
import type { FinanceStore, WebData, WebSyncResult } from "./store";

const FINANCE = `${API_ORIGIN}/api/client/v1/finance`;

async function get<T>(path: string, token: string): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${FINANCE}${path}`, {
      method: "GET",
      headers: { Accept: "application/json", Authorization: `Bearer ${token}` },
      credentials: "omit",
      cache: "no-store",
    });
  } catch {
    throw new AccountError("offline");
  }
  if (response.status === 401) throw new AccountError("unauthorized");
  if (response.status === 429) throw new AccountError("rate_limited");
  if (!response.ok) throw new AccountError("unknown");
  return (await response.json()) as T;
}

interface Summary { currency: Currency | null; version: string; statement_count: number; transaction_count: number }

export async function fetchWebData(token: string): Promise<WebData & { version: string }> {
  const summary = await get<Summary>("", token);
  const [{ statements }, { rules }, { categories }] = await Promise.all([
    get<{ statements: Array<{ id: number; filename: string; currency: Currency; sha256: string; transaction_count: number; closing_balance: string | null; closing_balance_on: string | null; imported_at: string }> }>("/statements", token),
    get<{ rules: Array<{ merchant_key: string; income: boolean; category: MerchantRule["category"] }> }>("/rules", token),
    // The person's own categories; a server without them answers 404, which means none.
    get<{ categories: string[] }>("/categories", token).catch((error: unknown) => {
      if (error instanceof AccountError && error.code === "unknown") return { categories: [] as string[] };
      throw error;
    }),
  ]);
  const transactions: WebData["transactions"] = [];
  let afterId = 0;
  for (let page = 0; page < 500; page += 1) {
    const body = await get<{ transactions: Array<{ id: number; statement_id: number; booked_on: string; description: string; amount: string; category: Category; tax_review: boolean; excluded: boolean }>; next_after_id: number | null }>(`/transactions?after_id=${afterId}`, token);
    for (const row of body.transactions) {
      transactions.push({ remoteId: row.id, remoteStatementId: row.statement_id, bookedOn: row.booked_on, description: row.description,
        amountCents: decimalToCents(row.amount), category: row.category, taxReview: row.tax_review, excluded: row.excluded });
    }
    if (!body.next_after_id) break;
    afterId = body.next_after_id;
  }
  return {
    version: summary.version,
    currency: summary.currency,
    statements: statements.map((s) => ({ remoteId: s.id, filename: s.filename, currency: s.currency, sha256: s.sha256, transactionCount: s.transaction_count,
      closingBalanceCents: s.closing_balance === null ? null : decimalToCents(s.closing_balance), closingBalanceOn: s.closing_balance_on, importedAt: s.imported_at })),
    transactions,
    rules: rules.map((r) => ({ merchantKey: r.merchant_key, income: r.income, category: r.category })),
    categories: Array.isArray(categories) ? categories.filter((name): name is string => typeof name === "string") : [],
  };
}

export type SyncOutcome =
  | { status: "disabled" }
  | { status: "upToDate" }
  | { status: "updated"; result: WebSyncResult };

/** Checks the website version; downloads and merges only when something changed. */
export async function syncFromWeb(store: FinanceStore, token: string, options: { force?: boolean } = {}): Promise<SyncOutcome> {
  const settings = await store.webSyncSettings();
  if (!settings.enabled) return { status: "disabled" };
  const summary = await get<Summary>("", token);
  if (!options.force && settings.version === summary.version) {
    await store.markWebChecked(null);
    return { status: "upToDate" };
  }
  const data = await fetchWebData(token);
  const result = await store.applyWebData(data);
  await store.markWebChecked(data.version);
  return { status: "updated", result };
}
