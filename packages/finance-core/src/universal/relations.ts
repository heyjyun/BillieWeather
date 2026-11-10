// Validate, part 2: how incoming rows relate to each other and to what is already stored.
// - Duplicates are account-scoped. A bank transaction id is trusted; otherwise rows are matched
//   by date + amount + description *with occurrence counting*, so an overlapping statement's
//   rows are recognized while two genuine identical purchases on the same day are both kept.
// - Internal transfers and card repayments are only suggested, never recategorized silently.
// - Balances are reconciled; a running balance that does not follow is flagged for review.
import { merchantKey } from "../categorizer";
import { toStorageCents } from "./currency";
import { issue, statusFor, type BalanceObservation, type CanonicalTransaction, type Reconciliation } from "./schema";

export interface ExistingTransaction {
  id: number;
  bookedOn: string;
  /** Stored fixed scale-2 amount. */
  amountCents: number;
  description: string;
  accountKey: string | null;
  bankReference: string | null;
}

const descriptionKey = (text: string) => text.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();

const compatible = (a: string | null, b: string | null) => a === null || b === null || a === b;

function cents(row: CanonicalTransaction): number | null {
  return row.amountMinor === null ? null : toStorageCents(row.amountMinor, row.currencyExponent);
}

function addIssue(row: CanonicalTransaction, item: ReturnType<typeof issue>) {
  if (!row.issues.some((existing) => existing.code === item.code)) row.issues.push(item);
  row.status = statusFor(row.issues);
}

export function markDuplicates(rows: CanonicalTransaction[], existing: readonly ExistingTransaction[]): void {
  const byReference = new Map<string, ExistingTransaction[]>();
  const byKey = new Map<string, ExistingTransaction[]>();
  const byDateAmount = new Map<string, ExistingTransaction[]>();
  for (const transaction of existing) {
    const push = (map: Map<string, ExistingTransaction[]>, key: string) => {
      const list = map.get(key);
      if (list) list.push(transaction);
      else map.set(key, [transaction]);
    };
    if (transaction.bankReference) push(byReference, transaction.bankReference);
    push(byKey, `${transaction.bookedOn}|${transaction.amountCents}|${descriptionKey(transaction.description)}`);
    push(byDateAmount, `${transaction.bookedOn}|${transaction.amountCents}`);
  }
  const seenReferences = new Set<string>();
  const occurrences = new Map<string, number>();
  for (const row of rows) {
    const amount = cents(row);
    if (row.status === "rejected" || amount === null || row.transactionDate === null) continue;
    const accountKey = row.account.key;
    if (row.bankReference) {
      const refKey = `${accountKey ?? ""}|${row.bankReference}`;
      if (seenReferences.has(refKey)) addIssue(row, issue("repeated_bank_reference_in_file", "review", "bankReference"));
      seenReferences.add(refKey);
      const match = (byReference.get(row.bankReference) ?? []).find((candidate) => compatible(candidate.accountKey, accountKey));
      if (match) {
        addIssue(row, issue("duplicate_bank_reference", "info", "bankReference", { id: match.id }));
        continue;
      }
    }
    const key = `${row.transactionDate}|${amount}|${descriptionKey(row.originalDescription)}`;
    const scopedKey = `${accountKey ?? ""}|${key}`;
    const seen = (occurrences.get(scopedKey) ?? 0) + 1;
    occurrences.set(scopedKey, seen);
    const stored = (byKey.get(key) ?? []).filter((candidate) => compatible(candidate.accountKey, accountKey));
    if (seen <= stored.length) {
      addIssue(row, issue("duplicate_overlap", "review", undefined, { count: stored.length }));
      continue;
    }
    // Same day and amount, same merchant written differently (e.g. a CSV and a PDF of the same account).
    const merchant = merchantKey(row.originalDescription);
    const near = (byDateAmount.get(`${row.transactionDate}|${amount}`) ?? []).filter((candidate) =>
      compatible(candidate.accountKey, accountKey) && descriptionKey(candidate.description) !== descriptionKey(row.originalDescription) &&
      merchant !== null && merchantKey(candidate.description) === merchant);
    if (near.length > 0) addIssue(row, issue("possible_duplicate", "review", undefined, { id: near[0].id }));
  }
}

const dayDistance = (a: string, b: string) => Math.abs(Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86_400_000;

/**
 * Opposite amounts within 3 days in two different known accounts look like money moving between
 * the person's own accounts. Only a hint: the person decides whether to file them as Transfers.
 */
export function markTransfers(rows: CanonicalTransaction[], existing: readonly ExistingTransaction[]): void {
  const pool = [
    ...rows.map((row) => ({ row, account: row.account.key, date: row.transactionDate, cents: cents(row) })),
    ...existing.map((transaction) => ({ row: null, account: transaction.accountKey, date: transaction.bookedOn, cents: transaction.amountCents })),
  ];
  // Indexed by amount so large files stay linear.
  const byAmount = new Map<number, typeof pool>();
  for (const entry of pool) {
    if (entry.cents === null || entry.account === null) continue;
    const list = byAmount.get(entry.cents);
    if (list) list.push(entry);
    else byAmount.set(entry.cents, [entry]);
  }
  for (const row of rows) {
    const amount = cents(row);
    if (!row.account.key || amount === null || amount === 0 || !row.transactionDate) continue;
    const match = (byAmount.get(-amount) ?? []).find((other) => other.row !== row && other.account !== row.account.key &&
      other.date !== null && dayDistance(other.date, row.transactionDate!) <= 3);
    if (match) {
      addIssue(row, issue("possible_transfer", "info", "category"));
      if (!row.kindHints.includes("transfer")) row.kindHints.push("transfer");
    }
  }
}

/** Running balances in date order: each row's balance must equal the previous balance plus its amount. */
export function reconcile(rows: readonly CanonicalTransaction[], statement: { opening?: BalanceObservation | null; closing?: BalanceObservation | null } = {}): Reconciliation[] {
  const groups = new Map<string | null, CanonicalTransaction[]>();
  for (const row of rows) {
    const list = groups.get(row.account.key);
    if (list) list.push(row);
    else groups.set(row.account.key, [row]);
  }
  const results: Reconciliation[] = [];
  for (const [accountKey, group] of groups) {
    const usable = group.filter((row) => row.amountMinor !== null && row.status !== "rejected");
    const netMinor = usable.reduce((sum, row) => sum + row.amountMinor!, 0);
    // File order is oldest-first or newest-first; pick the one the balances agree with.
    const ordered = (list: CanonicalTransaction[]) => list.filter((row) => row.balanceMinor !== null);
    const breaksFor = (list: CanonicalTransaction[]) => {
      const withBalance = ordered(list);
      const breaks: string[] = [];
      for (let i = 1; i < withBalance.length; i += 1) {
        if (withBalance[i - 1].balanceMinor! + withBalance[i].amountMinor! !== withBalance[i].balanceMinor) breaks.push(withBalance[i].id);
      }
      return breaks;
    };
    // Chronological order comes from the dates; only when every date is equal are both file orders tried.
    const dated = usable.filter((row) => row.transactionDate !== null);
    const firstDate = dated[0]?.transactionDate ?? "";
    const lastDate = dated[dated.length - 1]?.transactionDate ?? "";
    const forward = breaksFor(usable);
    const backward = breaksFor([...usable].reverse());
    const useForward = firstDate < lastDate || (firstDate === lastDate && forward.length <= backward.length);
    const chronological = useForward ? usable : [...usable].reverse();
    const runningBalanceBreaks = useForward ? forward : backward;
    const withBalance = ordered(chronological);
    const first = withBalance[0];
    const last = withBalance[withBalance.length - 1];
    const closing: BalanceObservation | null = statement.closing ?? (last ? { amountMinor: last.balanceMinor!, on: last.transactionDate, kind: "running_balance" } : null);
    const opening: BalanceObservation | null = statement.opening ??
      (first && runningBalanceBreaks.length === 0 && withBalance.length === chronological.length
        ? { amountMinor: first.balanceMinor! - first.amountMinor!, on: first.transactionDate, kind: "derived" }
        : null);
    const differenceMinor = opening && closing && (opening.kind !== "derived" || closing.kind !== "running_balance") ? opening.amountMinor + netMinor - closing.amountMinor : null;
    const balanceVerified: string[] = [];
    if (differenceMinor === 0 && opening?.kind === "statement_opening" && closing?.kind === "statement_closing") {
      balanceVerified.push(...chronological.map((row) => row.id));
    } else {
      chronological.forEach((row, index) => {
        if (row.balanceMinor === null) return;
        const previous = index > 0 ? chronological[index - 1].balanceMinor : statement.opening?.kind === "statement_opening" ? statement.opening.amountMinor : null;
        if (previous !== null && previous !== undefined && previous + row.amountMinor! === row.balanceMinor) balanceVerified.push(row.id);
      });
    }
    results.push({ accountKey, opening, closing, netMinor, differenceMinor, runningBalanceBreaks, balanceVerified });
  }
  return results;
}

/**
 * The same date, amount, description AND running balance twice in one file is the same line
 * printed twice (pages overlapping, a re-scanned page). Genuine repeated purchases have different
 * balances, so they are not affected. A person decides.
 */
export function markRepeatedRows(rows: CanonicalTransaction[]): void {
  const seen = new Set<string>();
  for (const row of rows) {
    if (row.status === "rejected" || row.balanceMinor === null || row.amountMinor === null) continue;
    const key = `${row.account.key ?? ""}|${row.transactionDate}|${row.amountMinor}|${descriptionKey(row.originalDescription)}|${row.balanceMinor}`;
    if (seen.has(key)) addIssue(row, issue("repeated_row_in_file", "review"));
    seen.add(key);
  }
}

/** Rows where the running balance breaks get a review issue: a sign or parsing error is the usual cause. */
export function markBalanceBreaks(rows: CanonicalTransaction[], reconciliations: readonly Reconciliation[]): void {
  const broken = new Set(reconciliations.flatMap((item) => item.runningBalanceBreaks));
  for (const row of rows) if (broken.has(row.id)) addIssue(row, issue("balance_mismatch", "review", "balance"));
}
