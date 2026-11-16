// "Organize my finances with AI" on the device: Analyze -> Preview -> Review -> Approve -> Apply -> Undo.
// Proposals come from packages/finance-core/src/ledger/organize.ts (on-device rules, no network).
// Optionally, Uncategorized merchants are also sent to the person's BillieWeather server through
// the existing consented "Categorize with AI" request (cleaned merchant text and direction only).
// Applying uses the ordinary ledger operations with actor "ai" and one batch id, so every change
// is in the activity log and the whole run can be undone. A person's locked fields are never changed.
import { aiGroups, cleanForAi, isAccountType, organizeProposals, type AccountType, type OrganizeRow, type Proposal, type TransactionKind } from "@billie/finance-core";
import { randomId } from "./ids";
import type { FinanceStore, SqlDriver } from "./store";

type Row = Record<string, unknown>;

export async function organizeRows(db: SqlDriver): Promise<OrganizeRow[]> {
  const rows = await db.select<Row>(`SELECT t.id, t.account_id, a.account_type, t.booked_on, t.amount_cents, t.kind, t.category, t.description, t.original_description, m.name AS merchant,
      t.user_locked_fields, t.entry_origin,
      EXISTS (SELECT 1 FROM transaction_links l WHERE (l.from_transaction_id = t.id OR l.to_transaction_id = t.id) AND l.status = 'confirmed' AND l.link_type IN ('transfer', 'card_payment', 'refund_of')) AS linked
    FROM transactions t LEFT JOIN accounts a ON a.id = t.account_id LEFT JOIN merchants m ON m.id = t.merchant_id WHERE t.deleted_at IS NULL AND t.excluded = 0`);
  return rows.map((row) => {
    let locked: string[] = [];
    try { locked = JSON.parse(String(row.user_locked_fields ?? "[]")) as string[]; } catch { locked = []; }
    const type = isAccountType(row.account_type) && row.account_type !== "other" ? (row.account_type as AccountType) : null;
    return {
      id: Number(row.id), accountId: row.account_id === null ? null : Number(row.account_id), accountType: type, occurredOn: String(row.booked_on), amountMinor: Number(row.amount_cents),
      kind: String(row.kind) as TransactionKind, category: String(row.category), description: String(row.description), originalDescription: String(row.original_description ?? row.description),
      merchant: (row.merchant as string | null) ?? null, lockedFields: locked, linked: Number(row.linked) === 1, origin: String(row.entry_origin ?? "import"),
    };
  });
}

export interface AnalyzeOptions {
  /** When given, Uncategorized merchants the rules could not place are sent to BillieWeather AI. */
  cloud?: (items: Array<{ key: string; text: string; direction: "in" | "out" }>, customCategories: readonly string[]) => Promise<Array<{ key: string; category: string }>>;
}

export async function analyze(store: FinanceStore, db: SqlDriver, options: AnalyzeOptions = {}): Promise<{ runId: string; proposals: Proposal[] }> {
  const rows = await organizeRows(db);
  const accounts = await store.ledger.accounts({ includeArchived: true });
  const liability = new Set(accounts.filter((a) => a.accountClass === "liability").map((a) => a.id));
  const proposals = organizeProposals(rows, { rules: await store.rules(), liability: (id) => liability.has(id) });
  if (options.cloud) {
    const placed = new Set(proposals.flatMap((p) => (p.type === "categorize" ? p.ids : [])));
    const leftover = rows.filter((row) => row.category === "Uncategorized" && !placed.has(row.id) && !row.lockedFields.includes("category") && ["expense", "income", "refund"].includes(row.kind));
    const groups = aiGroups(leftover.map((row) => ({ id: row.id, description: row.originalDescription, amountCents: row.kind === "income" ? Math.abs(row.amountMinor) : -Math.abs(row.amountMinor), category: row.category }))).slice(0, 150);
    if (groups.length > 0) {
      const custom = await store.customCategories();
      const answers = await options.cloud(groups.map((g) => ({ key: g.key, text: g.text, direction: g.direction })), custom);
      for (const answer of answers) {
        const group = groups.find((g) => g.key === answer.key);
        if (!group || answer.category === "Uncategorized" || answer.category === "Transfers") continue;
        if ((answer.category === "Income") !== (group.direction === "in")) continue;
        proposals.push({ id: `ai:${group.key}`, type: "categorize", ids: group.ids, category: answer.category, description: cleanForAi(group.text) ?? group.text, reason: "ai", confidence: 60 });
      }
    }
  }
  const runId = randomId();
  await db.execute("INSERT INTO organize_runs (uuid, created_at, status, engine, proposals) VALUES (?, ?, 'preview', ?, ?)", [runId, new Date().toISOString(), options.cloud ? "rules+ai" : "rules", JSON.stringify(proposals)]);
  return { runId, proposals };
}

/** Applies the approved proposals as one batch. Returns the batch id and how many proposals were applied. */
export async function applyProposals(store: FinanceStore, db: SqlDriver, runId: string, approved: readonly Proposal[], options: { rememberCategories?: boolean } = {}): Promise<{ batchId: string; applied: number }> {
  const batchId = randomId();
  const L = store.ledger;
  let applied = 0;
  for (const proposal of approved) {
    try {
      switch (proposal.type) {
        case "categorize":
          if ((await L.batchUpdate(proposal.ids, { category: proposal.category }, "ai", batchId, { categorySource: "ai", confidence: proposal.confidence, model: proposal.reason === "ai" ? "billieweather-ai" : "rules", lock: false })) > 0) applied += 1;
          break;
        case "transfer":
        case "card_payment":
          await L.linkTransfer(proposal.outId, proposal.inId, "ai", batchId, "ai");
          applied += 1;
          break;
        case "refund":
          await L.linkRefund(proposal.refundId, proposal.expenseId, "ai", batchId, "ai");
          applied += 1;
          break;
        case "duplicate":
          await L.markDuplicate(proposal.duplicateId, proposal.ofId, "ai", batchId, "ai");
          applied += 1;
          break;
        case "suspect_income":
          await L.setKind(proposal.entryId, proposal.kind, "ai", batchId, { categorySource: "ai", lock: false });
          applied += 1;
          break;
        case "merchant":
          if ((await L.batchUpdate(proposal.ids, { merchant: proposal.merchant }, "ai", batchId, { lock: false })) > 0) applied += 1;
          break;
        case "recurring":
          // A schedule is a new object the person reviews on the Budgets & schedules page; it posts nothing by itself.
          applied += 0;
          break;
      }
    } catch {
      // A proposal that no longer fits (the row changed meanwhile) is skipped; the rest still apply.
    }
  }
  await db.execute("UPDATE organize_runs SET status = 'applied', applied_at = ?, batch_id = ? WHERE uuid = ?", [new Date().toISOString(), batchId, runId]);
  if (options.rememberCategories) {
    for (const proposal of approved) if (proposal.type === "categorize") {
      const [first] = proposal.ids;
      if (first !== undefined) await store.setCategory(first, proposal.category, true).catch(() => 0);
    }
  }
  await L.audit({ actor: "ai", action: "ai_apply", subjectType: "batch", subjectId: batchId, batchId: null, summary: `${applied} of ${approved.length} proposals applied` });
  return { batchId, applied };
}

export async function undoRun(store: FinanceStore, db: SqlDriver, batchId: string): Promise<number> {
  const steps = await store.ledger.undoBatch(batchId);
  await db.execute("UPDATE organize_runs SET status = 'undone', undone_at = ? WHERE batch_id = ?", [new Date().toISOString(), batchId]);
  return steps;
}
