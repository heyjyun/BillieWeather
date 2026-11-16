// "Organize my finances" — proposals only. Pure functions over plain rows: they never change data.
// The host shows the proposals, the person approves some, and the host applies them through the
// ordinary manual-bookkeeping operations (same financial model, audited, undoable as one batch).
// Fields a person locked are never proposed for change (invariant I-16).
import { Categorizer, merchantKey, titleizeMerchant } from "../categorizer";
import type { MerchantRule } from "@billie/shared-types";
import { inferKind, type AccountType, type TransactionKind } from "./domain";

export interface OrganizeRow {
  id: number;
  accountId: number | null;
  accountType: AccountType | null;
  occurredOn: string;
  amountMinor: number;
  kind: TransactionKind;
  category: string;
  description: string;
  originalDescription: string;
  merchant: string | null;
  lockedFields: readonly string[];
  /** Already part of a transfer / card payment / refund link. */
  linked: boolean;
  origin: string;
}

export type Proposal =
  | { id: string; type: "categorize"; ids: number[]; category: string; description: string; reason: "rule" | "keywords" | "ai"; confidence: number }
  | { id: string; type: "transfer" | "card_payment"; outId: number; inId: number; amountMinor: number; reason: "opposite"; confidence: number }
  | { id: string; type: "refund"; refundId: number; expenseId: number; amountMinor: number; reason: "refund_words"; confidence: number }
  | { id: string; type: "duplicate"; duplicateId: number; ofId: number; reason: "same_row"; confidence: number }
  | { id: string; type: "recurring"; ids: number[]; merchant: string; cadenceDays: number; amountMinor: number; reason: "cadence"; confidence: number }
  | { id: string; type: "merchant"; ids: number[]; merchant: string; description: string; reason: "merchant_words"; confidence: number }
  | { id: string; type: "suspect_income"; entryId: number; kind: TransactionKind; reason: "account_type"; confidence: number };

const days = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
const key = (text: string) => text.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
const free = (row: OrganizeRow, field: string) => !row.lockedFields.includes(field);

/** Every proposal for these live rows. `liability(accountId)` says whether an account is a card or loan. */
export function organizeProposals(rows: readonly OrganizeRow[], options: { rules?: readonly MerchantRule[]; liability: (accountId: number) => boolean }): Proposal[] {
  const out: Proposal[] = [];
  const used = new Set<number>();

  // 1. Duplicates: same account, date, amount and original text, both live (an overlapping import kept twice).
  const seen = new Map<string, OrganizeRow>();
  for (const row of [...rows].sort((a, b) => a.id - b.id)) {
    if (row.origin === "manual" || row.origin === "recurring") continue;
    const k = `${row.accountId}|${row.occurredOn}|${row.amountMinor}|${key(row.originalDescription)}`;
    const first = seen.get(k);
    if (first && row.accountId !== null) {
      out.push({ id: `dup:${row.id}`, type: "duplicate", duplicateId: row.id, ofId: first.id, reason: "same_row", confidence: 70 });
      used.add(row.id);
    } else seen.set(k, row);
  }

  // 2. Transfers and card payments: opposite amounts within 3 days in two different accounts, not linked yet.
  const unlinked = rows.filter((row) => !row.linked && !used.has(row.id) && row.accountId !== null && row.amountMinor !== 0 && free(row, "kind"));
  const ins = new Map<number, OrganizeRow[]>();
  for (const row of unlinked) if (row.amountMinor > 0) ins.set(row.amountMinor, [...(ins.get(row.amountMinor) ?? []), row]);
  for (const outRow of unlinked.filter((row) => row.amountMinor < 0).sort((a, b) => a.occurredOn.localeCompare(b.occurredOn))) {
    const match = (ins.get(-outRow.amountMinor) ?? []).find((inRow) => !used.has(inRow.id) && inRow.accountId !== outRow.accountId && Math.abs(days(outRow.occurredOn, inRow.occurredOn)) <= 3);
    if (!match) continue;
    used.add(outRow.id);
    used.add(match.id);
    const card = options.liability(match.accountId!);
    const named = /transfer|xfer|payment|autopay|转账|还款/i.test(`${outRow.originalDescription} ${match.originalDescription}`);
    out.push({ id: `xfer:${outRow.id}:${match.id}`, type: card ? "card_payment" : "transfer", outId: outRow.id, inId: match.id, amountMinor: match.amountMinor, reason: "opposite", confidence: named ? 90 : 65 });
  }

  // 3. Refunds: money in that is not linked, matched to an earlier expense of the same merchant in the same account.
  for (const refund of rows.filter((row) => row.amountMinor > 0 && !row.linked && !used.has(row.id) && (row.kind === "refund" || row.kind === "income") && free(row, "kind"))) {
    const merchant = merchantKey(refund.originalDescription);
    if (!merchant) continue;
    const looksRefund = inferKind({ amountMinor: refund.amountMinor, accountType: refund.accountType, description: refund.originalDescription }) === "refund" || refund.kind === "refund";
    if (!looksRefund) continue;
    const original = rows
      .filter((row) => row.kind === "expense" && row.amountMinor <= -refund.amountMinor && row.accountId === refund.accountId && merchantKey(row.originalDescription) === merchant)
      .filter((row) => { const gap = days(row.occurredOn, refund.occurredOn); return gap >= 0 && gap <= 120; })
      .sort((a, b) => b.occurredOn.localeCompare(a.occurredOn))[0];
    if (!original) continue;
    used.add(refund.id);
    out.push({ id: `refund:${refund.id}:${original.id}`, type: "refund", refundId: refund.id, expenseId: original.id, amountMinor: refund.amountMinor, reason: "refund_words", confidence: original.amountMinor === -refund.amountMinor ? 85 : 70 });
  }

  // 4. Money in that is probably not income (legacy rows, or before account types were known).
  for (const row of rows) {
    if (used.has(row.id) || row.kind !== "income" || !free(row, "kind")) continue;
    const kind = inferKind({ amountMinor: row.amountMinor, accountType: row.accountType, description: row.originalDescription });
    if (kind !== "income" && kind !== "transfer") out.push({ id: `kind:${row.id}`, type: "suspect_income", entryId: row.id, kind, reason: "account_type", confidence: 75 });
  }

  // 5. Categories for Uncategorized expense/income/refund rows, grouped by merchant (rules and keyword lists; AI optional, added by the host).
  const categorizer = new Categorizer([...(options.rules ?? [])]);
  const groups = new Map<string, { category: string; ids: number[]; description: string; reason: "rule" | "keywords" }>();
  for (const row of rows) {
    if (row.category !== "Uncategorized" || !free(row, "category") || !["expense", "income", "refund"].includes(row.kind)) continue;
    const decided = categorizer.explain(row.originalDescription, row.amountMinor, row.accountType);
    if (decided.category === "Uncategorized" || decided.category === "Transfers" || (decided.category === "Income") !== (row.kind === "income")) continue;
    const groupKey = `${decided.category}|${merchantKey(row.originalDescription) ?? row.id}`;
    const group = groups.get(groupKey) ?? { category: decided.category, ids: [], description: row.description, reason: decided.reason === "learned" ? "rule" as const : "keywords" as const };
    group.ids.push(row.id);
    groups.set(groupKey, group);
  }
  for (const [groupKey, group] of groups) out.push({ id: `cat:${groupKey}`, type: "categorize", ids: group.ids, category: group.category, description: group.description, reason: group.reason, confidence: group.reason === "rule" ? 95 : 70 });

  // 6. Merchant names for imported rows without one (bank codes and numbers removed).
  const byMerchant = new Map<string, { ids: number[]; description: string }>();
  for (const row of rows) {
    if (row.merchant || !free(row, "merchant") || row.kind === "transfer" || row.kind === "card_payment" || row.kind === "adjustment") continue;
    const name = titleizeMerchant(merchantKey(row.originalDescription));
    if (!name) continue;
    const entry = byMerchant.get(name) ?? { ids: [], description: row.description };
    entry.ids.push(row.id);
    byMerchant.set(name, entry);
  }
  for (const [merchant, entry] of byMerchant) if (entry.ids.length >= 2) out.push({ id: `merchant:${merchant}`, type: "merchant", ids: entry.ids, merchant, description: entry.description, reason: "merchant_words", confidence: 60 });

  // 7. Recurring payments: the same merchant and amount at least 3 times at a steady interval (7, 14, ~30, ~365 days).
  const series = new Map<string, OrganizeRow[]>();
  for (const row of rows) {
    if (row.kind !== "expense" && row.kind !== "income") continue;
    const merchant = merchantKey(row.originalDescription);
    if (merchant) series.set(`${merchant}|${row.amountMinor}`, [...(series.get(`${merchant}|${row.amountMinor}`) ?? []), row]);
  }
  for (const [seriesKey, items] of series) {
    if (items.length < 3) continue;
    const sorted = [...items].sort((a, b) => a.occurredOn.localeCompare(b.occurredOn));
    const gaps = sorted.slice(1).map((row, i) => days(sorted[i].occurredOn, row.occurredOn));
    const average = gaps.reduce((s, g) => s + g, 0) / gaps.length;
    const cadence = [7, 14, 30, 365].find((target) => Math.abs(average - target) <= (target >= 30 ? 4 : 1) && gaps.every((g) => Math.abs(g - target) <= (target >= 30 ? 6 : 2)));
    if (!cadence) continue;
    out.push({ id: `recurring:${seriesKey}`, type: "recurring", ids: sorted.map((row) => row.id), merchant: titleizeMerchant(seriesKey.split("|")[0]) ?? seriesKey, cadenceDays: cadence, amountMinor: sorted[0].amountMinor, reason: "cadence", confidence: 80 });
  }
  return out;
}
