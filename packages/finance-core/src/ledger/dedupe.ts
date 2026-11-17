// Row-level duplicate detection over plain rows: the one implementation every local import path
// uses (universal/relations.ts markDuplicates for CSV/XLSX/OFX/OCR drafts, pdf.ts markPdfDuplicates
// for text PDFs) and the contract shared with Rails (app/services/finance/duplicate_detector.rb).
// Cases: packages/finance-core/fixtures/dedupe-cases.json.
import { merchantKey } from "../categorizer";

export interface DedupeRow {
  account: string | null;
  date: string;
  amountMinor: number;
  description: string;
  reference?: string | null;
}

export interface StoredDedupeRow extends DedupeRow {
  id: number | string;
}

export type DedupeVerdict =
  | { result: "new" }
  | { result: "duplicate"; of: StoredDedupeRow["id"]; reason: "bank_reference" }
  /** `matches`: how many stored rows of the same account have this exact date, amount and description. */
  | { result: "duplicate"; of: StoredDedupeRow["id"]; reason: "overlap"; matches: number }
  | { result: "review"; of: StoredDedupeRow["id"]; reason: "near_match" | "unknown_account" };

export const descriptionKey = (text: string) => text.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();

/**
 * For each incoming row (in file order): an automatic duplicate (same account and bank reference,
 * or an exact date+amount+description match with occurrence counting), a possible duplicate a
 * person must decide (same merchant written differently, or a match only against a row whose
 * account is unknown), or new.
 */
export function detectDuplicates(existing: readonly StoredDedupeRow[], incoming: readonly DedupeRow[]): DedupeVerdict[] {
  const byReference = new Map<string, StoredDedupeRow[]>();
  const byKey = new Map<string, StoredDedupeRow[]>();
  const byDateAmount = new Map<string, StoredDedupeRow[]>();
  const push = (map: Map<string, StoredDedupeRow[]>, key: string, row: StoredDedupeRow) => {
    const list = map.get(key);
    if (list) list.push(row);
    else map.set(key, [row]);
  };
  for (const row of existing) {
    if (row.reference) push(byReference, row.reference, row);
    push(byKey, `${row.date}|${row.amountMinor}|${descriptionKey(row.description)}`, row);
    push(byDateAmount, `${row.date}|${row.amountMinor}`, row);
  }
  const occurrences = new Map<string, number>();
  return incoming.map((row): DedupeVerdict => {
    if (row.reference) {
      const match = (byReference.get(row.reference) ?? []).find((candidate) => candidate.account === row.account);
      if (match) return { result: "duplicate", of: match.id, reason: "bank_reference" };
    }
    const key = `${row.date}|${row.amountMinor}|${descriptionKey(row.description)}`;
    const scoped = `${row.account ?? ""}|${key}`;
    const seen = (occurrences.get(scoped) ?? 0) + 1;
    occurrences.set(scoped, seen);
    const candidates = byKey.get(key) ?? [];
    const same = candidates.filter((candidate) => candidate.account === row.account);
    if (seen <= same.length) return { result: "duplicate", of: same[seen - 1].id, reason: "overlap", matches: same.length };
    const unknown = candidates.filter((candidate) => candidate.account !== row.account && (candidate.account === null || row.account === null));
    if (seen - same.length <= unknown.length) return { result: "review", of: unknown[seen - same.length - 1].id, reason: "unknown_account" };
    const merchant = merchantKey(row.description);
    if (merchant !== null) {
      const near = (byDateAmount.get(`${row.date}|${row.amountMinor}`) ?? []).find((candidate) =>
        candidate.account === row.account && descriptionKey(candidate.description) !== descriptionKey(row.description) && merchantKey(candidate.description) === merchant);
      if (near) return { result: "review", of: near.id, reason: "near_match" };
    }
    return { result: "new" };
  });
}
