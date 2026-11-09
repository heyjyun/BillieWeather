// Moves data between two databases on the Data page: one local database to another, a local
// database up to the cloud, or the cloud down into a local database. It only ever adds what
// the target does not have (matched by statement file hash), so running a transfer twice is
// harmless, and it never deletes anything from either side.
//
// Local → local goes straight between the two files on this device; the cloud is touched only
// if "also keep in the cloud" is ticked.
import { AccountError } from "./account";
import { uploadStatement } from "./cloudUpload";
import type { FinanceStore, StatementInventoryItem, TransferData } from "./store";
import { fetchWebData } from "./webSync";

export type Endpoint = { kind: "local"; id: string } | { kind: "cloud" };

export const sameEndpoint = (a: Endpoint, b: Endpoint) => a.kind === b.kind && (a.kind === "cloud" || (b.kind === "local" && a.id === b.id));

export interface TransferContext {
  openStore: (id: string) => Promise<FinanceStore>;
  getToken: () => string | null;
}

export interface TransferOutcome {
  statementsAdded: number;
  transactionsAdded: number;
  /** Statements the target already had. */
  skipped: number;
  /** Statements also kept in the cloud (local → local with the box ticked). */
  keptInCloud: number;
}

/** What a transfer would add: the source's statements the target doesn't have yet. */
export function previewTransfer(source: Array<Pick<StatementInventoryItem, "sha256" | "transactionCount">>, targetHashes: ReadonlySet<string>) {
  const missing = source.filter((item) => !targetHashes.has(item.sha256));
  return { statements: missing.length, transactions: missing.reduce((sum, item) => sum + item.transactionCount, 0), alreadyThere: source.length - missing.length };
}

async function readCloud(token: string): Promise<TransferData> {
  const web = await fetchWebData(token);
  const rows = new Map<number, TransferData["statements"][number]["rows"]>();
  for (const t of web.transactions) {
    const list = rows.get(t.remoteStatementId) ?? [];
    list.push({ bookedOn: t.bookedOn, description: t.description, amountCents: t.amountCents, category: t.category, taxReview: t.taxReview, excluded: t.excluded });
    rows.set(t.remoteStatementId, list);
  }
  return {
    statements: web.statements.map((s) => ({
      filename: s.filename, currency: s.currency, sha256: s.sha256, closingBalanceCents: s.closingBalanceCents,
      closingBalanceOn: s.closingBalanceOn, importedAt: s.importedAt, rows: rows.get(s.remoteId) ?? [],
    })),
    rules: web.rules,
  };
}

async function sendToCloud(token: string, data: TransferData): Promise<{ added: number; transactions: number; skipped: number }> {
  let added = 0;
  let transactions = 0;
  let skipped = 0;
  for (const statement of data.statements) {
    if (statement.rows.length === 0) continue;
    const sent = await uploadStatement(token, statement);
    if (sent.created) {
      added += 1;
      transactions += statement.rows.length;
    } else skipped += 1;
  }
  return { added, transactions, skipped };
}

export async function runTransfer(source: Endpoint, target: Endpoint, keepInCloud: boolean, context: TransferContext): Promise<TransferOutcome> {
  if (sameEndpoint(source, target)) throw new Error("A database cannot be copied onto itself.");
  const needsCloud = source.kind === "cloud" || target.kind === "cloud" || keepInCloud;
  const token = context.getToken();
  if (needsCloud && !token) throw new AccountError("unauthorized");

  const data = source.kind === "cloud" ? await readCloud(token!) : await (await context.openStore(source.id)).exportData();

  let outcome: TransferOutcome;
  if (target.kind === "cloud") {
    const sent = await sendToCloud(token!, data);
    outcome = { statementsAdded: sent.added, transactionsAdded: sent.transactions, skipped: sent.skipped, keptInCloud: 0 };
  } else {
    const merged = await (await context.openStore(target.id)).mergeData(data);
    outcome = { statementsAdded: merged.statementsAdded, transactionsAdded: merged.transactionsAdded, skipped: merged.skipped, keptInCloud: 0 };
    if (keepInCloud && source.kind === "local") outcome.keptInCloud = (await sendToCloud(token!, data)).added;
  }
  return outcome;
}
