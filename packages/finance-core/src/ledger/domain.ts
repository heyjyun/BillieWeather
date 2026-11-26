// The logical finance model shared by every platform (option C, "hybrid ledger", of
// docs/architecture/financial-database-review.md §H). Enums and rules come from
// packages/finance-core/schema/financial-schema.json, which Rails reads too
// (app/models/finance/domain.rb), so both sides interpret a transaction the same way.
//
// Key rules:
// - Every entry belongs to one account and has an explicit `kind`. Income and expense come from
//   the kind, never from the sign alone: a refund or a card repayment is not income.
// - Amounts are signed integer minor units from the ACCOUNT's point of view (money in > 0).
//   A purchase on a credit card is negative (more owed); a repayment to the card is positive.
// - Balances, totals and net worth are derived; nothing here stores them.
import schema from "../../schema/financial-schema.json";

export const DOMAIN_VERSION: number = schema.version;

export type AccountType = keyof typeof schema.account_types;
export type AccountClass = "asset" | "liability";
export type TransactionKind = keyof typeof schema.transaction_kinds;
export type LinkType = keyof typeof schema.link_types;
export type LinkStatus = "suggested" | "confirmed" | "rejected";
export type DecidedBy = "user" | "rule" | "auto" | "ai";
export type CategoryKind = "expense" | "income";
export type EntryOrigin = "import" | "manual" | "web_copy" | "upload" | "recurring" | "legacy" | "receipt";
export type LockedField = "category" | "kind" | "description" | "excluded" | "merchant" | "project" | "account";
export type AuditActor = "user" | "import" | "rule" | "ai" | "system" | "sync" | "recurring";
export type BudgetPeriod = "month" | "year";
export type Frequency = "daily" | "weekly" | "monthly" | "yearly";

export const ACCOUNT_TYPES = Object.keys(schema.account_types) as AccountType[];
export const TRANSACTION_KINDS = Object.keys(schema.transaction_kinds) as TransactionKind[];
export const LINK_TYPES = Object.keys(schema.link_types) as LinkType[];
export const ENTRY_ORIGINS = schema.entry_origins as EntryOrigin[];
export const LOCKED_FIELDS = schema.locked_fields as LockedField[];
export const BUDGET_PERIODS = schema.budget_periods as BudgetPeriod[];
export const FREQUENCIES = schema.recurrence_frequencies as Frequency[];
/**
 * Categories nest without a depth limit since 2026-11 (docs/architecture/category-hierarchy.md); the
 * schema's old `category_max_depth` is no longer enforced.
 */
export const CATEGORY_MAX_DEPTH: number = Number.POSITIVE_INFINITY;

export const isAccountType = (value: unknown): value is AccountType => typeof value === "string" && value in schema.account_types;
export const isTransactionKind = (value: unknown): value is TransactionKind => typeof value === "string" && value in schema.transaction_kinds;

export function accountClass(type: AccountType): AccountClass {
  return schema.account_types[type].class as AccountClass;
}
export const isLiability = (type: AccountType) => accountClass(type) === "liability";

/** Maps the older vocabularies (web bank_accounts.kind, local statements.account_kind) to an account type. */
export function accountTypeFromLegacy(kind: string | null | undefined, side: "web" | "local"): AccountType {
  const table = schema.legacy_account_kinds[side] as Record<string, string>;
  const mapped = kind ? table[kind] : undefined;
  return isAccountType(mapped) ? mapped : "other";
}

/** "income", "expense" or null (kinds that never count in income/expense totals). */
export function countsAs(kind: TransactionKind): "income" | "expense" | null {
  return schema.transaction_kinds[kind].counts as "income" | "expense" | null;
}

/** The category tree a kind may use, or null when it carries no category (transfers, adjustments). */
export function categoryKindFor(kind: TransactionKind): CategoryKind | null {
  return schema.transaction_kinds[kind].category_kind as CategoryKind | null;
}

/**
 * The stored (signed) amount for a manual entry typed as a positive number. Transfers and
 * card payments have two legs (see `transferLegs`); adjustments are signed by the caller.
 */
export function signedAmount(kind: TransactionKind, positiveMinor: number): number {
  const abs = Math.abs(positiveMinor);
  switch (schema.transaction_kinds[kind].sign) {
    case "out": return -abs;
    case "in": return abs;
    default: return positiveMinor;
  }
}

/** The two legs of a transfer: the source account loses the amount, the destination gains it. */
export function transferLegs(positiveMinor: number): { from: number; to: number } {
  const abs = Math.abs(positiveMinor);
  return { from: -abs, to: abs };
}

/** A transfer into a liability account (credit card, loan) is a card payment; anything else a transfer. */
export function transferKind(toType: AccountType): "transfer" | "card_payment" {
  return isLiability(toType) ? "card_payment" : "transfer";
}

const compile = (patterns: string[]) => new RegExp(patterns.join("|"), "iu");
const CARD_PAYMENT = compile(schema.kind_inference.card_payment_patterns);
const CARD_PAYMENT_OUT = compile(schema.kind_inference.card_payment_outflow_patterns);
const CARD_STATEMENT_PAYMENT = /\bpayment\W+thank\W+you\b|\bpayment\W+received\b/iu;
const REFUND = compile(schema.kind_inference.refund_patterns);
const TRANSFER = compile(schema.kind_inference.transfer_patterns);

/**
 * The economic kind of an IMPORTED row (manual entries carry an explicit kind). Uses the account
 * type when it is known; a positive amount on a credit card is a repayment or a refund, never income.
 * Cases: packages/finance-core/fixtures/kind-cases.json (also checked by Rails).
 */
export function inferKind(input: { amountMinor: number; accountType: AccountType | null; description: string }): TransactionKind {
  const { amountMinor, description } = input;
  if (amountMinor === 0) return "ignored";
  const liability = input.accountType !== null && isLiability(input.accountType);
  if (liability) {
    if (amountMinor > 0) return CARD_PAYMENT.test(description) ? "card_payment" : "refund";
    return TRANSFER.test(description) ? "transfer" : "expense";
  }
  if (amountMinor > 0) {
    if (CARD_STATEMENT_PAYMENT.test(description)) return "card_payment";
    if (REFUND.test(description)) return "refund";
    if (TRANSFER.test(description)) return "transfer";
    return "income";
  }
  if (CARD_PAYMENT_OUT.test(description)) return "card_payment";
  if (TRANSFER.test(description)) return "transfer";
  return "expense";
}

/**
 * The kind stored for an imported row once its category is decided (by a person, the file, a rule
 * or the keyword lists). The category wins over the description: "Transfers" makes it transfer-like,
 * "Income" (or an income-kind category) makes it income, any other category on money in is a refund.
 * Cases: fixtures/kind-cases.json "categorized".
 */
export function kindForCategorized(input: {
  amountMinor: number; accountType: AccountType | null; description: string; category: string; incomeCategories?: ReadonlySet<string>;
  /** The category's tree (CategoryTree.kindOf). Without it, the old built-in names decide. */
  categoryKind?: "income" | "expense" | "transfer" | null;
}): TransactionKind {
  const inferred = inferKind(input);
  const tree = input.categoryKind !== undefined ? input.categoryKind
    : input.category === "Transfers" ? "transfer" : input.category === "Income" || input.incomeCategories?.has(input.category) ? "income" : null;
  if (tree === "transfer") return inferred === "card_payment" ? "card_payment" : "transfer";
  if (tree === "income") return "income";
  if (input.amountMinor === 0) return "ignored";
  if (input.amountMinor < 0) return "expense";
  if (input.category === "Uncategorized") return inferred === "income" ? "income" : "refund";
  return "refund";
}

/**
 * The kind an existing row gets when the `kind` column is added: reproduces today's totals exactly
 * (Transfers category => transfer, otherwise the sign), so the migration itself changes no total.
 * Rows that look like refunds or card payments are then listed for review (`suspectIncome`).
 */
export function legacyKind(input: { amountMinor: number; category: string }): TransactionKind {
  if (input.category === "Transfers") return "transfer";
  return input.amountMinor > 0 ? "income" : "expense";
}

/** True when a row counted as income probably is not income (a refund or a card repayment). */
export function suspectIncome(input: { kind: TransactionKind; amountMinor: number; accountType: AccountType | null; description: string }): TransactionKind | null {
  if (input.kind !== "income") return null;
  const inferred = inferKind(input);
  return inferred === "income" ? null : inferred;
}

// ---------------------------------------------------------------------------------------------
// Entries, totals and balances. Pure functions over plain rows, used by the local store and by
// the shared scenario fixtures that Rails replays.

export interface LedgerEntry {
  id: number | string;
  accountId: number | string | null;
  occurredOn: string;
  amountMinor: number;
  kind: TransactionKind;
  category: string;
  excluded?: boolean;
  deleted?: boolean;
  merchant?: string | null;
  project?: string | null;
  tags?: readonly string[];
}

export interface LedgerAccount {
  id: number | string;
  type: AccountType;
  openingBalanceMinor: number;
  includeInNetWorth?: boolean;
  archived?: boolean;
}

/** Whether an entry is part of totals and balances at all (not deleted). */
export const isLive = (entry: Pick<LedgerEntry, "deleted">) => !entry.deleted;
/** Whether an entry counts in income/expense totals. */
export const isCountedEntry = (entry: LedgerEntry) => isLive(entry) && !entry.excluded && countsAs(entry.kind) !== null;

export interface Totals {
  incomeMinor: number;
  expenseMinor: number;
  netMinor: number;
  /** Expense categories net of refunds (positive = spent). */
  expenseByCategory: Record<string, number>;
  incomeByCategory: Record<string, number>;
}

/** Income and expense by kind (refunds reduce spending in their category). */
export function totals(entries: readonly LedgerEntry[], range: { from?: string | null; to?: string | null } = {}): Totals {
  const result: Totals = { incomeMinor: 0, expenseMinor: 0, netMinor: 0, expenseByCategory: {}, incomeByCategory: {} };
  for (const entry of entries) {
    if (!isCountedEntry(entry)) continue;
    if (range.from && entry.occurredOn < range.from) continue;
    if (range.to && entry.occurredOn > range.to) continue;
    if (countsAs(entry.kind) === "income") {
      result.incomeMinor += entry.amountMinor;
      result.incomeByCategory[entry.category] = (result.incomeByCategory[entry.category] ?? 0) + entry.amountMinor;
    } else {
      result.expenseMinor -= entry.amountMinor;
      result.expenseByCategory[entry.category] = (result.expenseByCategory[entry.category] ?? 0) - entry.amountMinor;
    }
  }
  result.netMinor = result.incomeMinor - result.expenseMinor;
  return result;
}

/**
 * Balance of each account on `asOf` (inclusive): opening balance plus every live entry, whatever
 * its kind (transfers and adjustments move balances; `excluded` only hides a row from totals).
 */
export function balances(accounts: readonly LedgerAccount[], entries: readonly LedgerEntry[], asOf?: string | null): Map<LedgerAccount["id"], number> {
  const result = new Map<LedgerAccount["id"], number>();
  for (const account of accounts) result.set(account.id, account.openingBalanceMinor);
  for (const entry of entries) {
    if (!isLive(entry) || entry.accountId === null || !result.has(entry.accountId)) continue;
    if (asOf && entry.occurredOn > asOf) continue;
    result.set(entry.accountId, result.get(entry.accountId)! + entry.amountMinor);
  }
  return result;
}

/** Assets, liabilities (as a positive amount owed) and net worth over accounts included in net worth. */
export function netWorth(accounts: readonly LedgerAccount[], entries: readonly LedgerEntry[], asOf?: string | null): { assetsMinor: number; liabilitiesMinor: number; netWorthMinor: number } {
  const byAccount = balances(accounts, entries, asOf);
  let assetsMinor = 0;
  let liabilitiesMinor = 0;
  for (const account of accounts) {
    if (account.includeInNetWorth === false) continue;
    const balance = byAccount.get(account.id) ?? 0;
    if (isLiability(account.type)) liabilitiesMinor -= balance;
    else assetsMinor += balance;
  }
  return { assetsMinor, liabilitiesMinor, netWorthMinor: assetsMinor - liabilitiesMinor };
}

/** The adjustment entry that brings an account from its computed balance to what the person sees. */
export function adjustmentFor(currentMinor: number, targetMinor: number): number {
  return targetMinor - currentMinor;
}

/** How much of an expense is still refundable, given the refunds already linked to it. */
export function refundableMinor(expenseMinor: number, refundsMinor: readonly number[]): number {
  return Math.max(0, Math.abs(expenseMinor) - refundsMinor.reduce((sum, value) => sum + Math.abs(value), 0));
}

/** A real calendar date written YYYY-MM-DD between 1900 and 2100 (Date.parse would roll 02-30 over to March). */
export function isIsoDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  if (year < 1900 || year > 2100 || month < 1 || month > 12 || day < 1) return false;
  return day <= new Date(Date.UTC(year, month, 0)).getUTCDate();
}

export type EntryProblem =
  | "amount_required" | "amount_zero" | "amount_too_large" | "amount_precision" | "date_invalid" | "account_required" | "accounts_same"
  | "category_kind" | "refund_target_required" | "refund_too_large" | "kind_invalid";

const MAX_MINOR = 10 ** 15;

/**
 * Validates a manual entry before it is saved (the same checks run in Rails). `amountMinor` is the
 * positive amount typed by the person; adjustments may be negative.
 */
export function entryProblems(input: {
  kind: TransactionKind | string;
  amountMinor: number | null;
  occurredOn: string;
  accountId: unknown;
  toAccountId?: unknown;
  categoryKind?: CategoryKind | "transfer" | "any" | null;
  refundOf?: { amountMinor: number; refundedMinor: number } | null;
}): EntryProblem[] {
  const problems: EntryProblem[] = [];
  if (!isTransactionKind(input.kind)) return ["kind_invalid"];
  const kind = input.kind;
  if (input.amountMinor === null || !Number.isFinite(input.amountMinor)) problems.push("amount_required");
  else {
    if (!Number.isInteger(input.amountMinor)) problems.push("amount_precision");
    if (Math.abs(input.amountMinor) >= MAX_MINOR) problems.push("amount_too_large");
    if (input.amountMinor === 0 && kind !== "adjustment") problems.push("amount_zero");
  }
  if (!isIsoDate(input.occurredOn)) problems.push("date_invalid");
  if (input.accountId === null || input.accountId === undefined || input.accountId === "") problems.push("account_required");
  if (kind === "transfer" || kind === "card_payment") {
    if (input.toAccountId === null || input.toAccountId === undefined || input.toAccountId === "") problems.push("account_required");
    else if (String(input.toAccountId) === String(input.accountId)) problems.push("accounts_same");
  }
  const wanted = categoryKindFor(kind);
  if (wanted && input.categoryKind && input.categoryKind !== "any" && input.categoryKind !== wanted) problems.push("category_kind");
  if (kind === "refund" && input.refundOf !== undefined) {
    if (!input.refundOf) problems.push("refund_target_required");
    else if (input.amountMinor !== null && Math.abs(input.amountMinor) > refundableMinor(input.refundOf.amountMinor, [input.refundOf.refundedMinor])) problems.push("refund_too_large");
  }
  return [...new Set(problems)];
}

// ---------------------------------------------------------------------------------------------
// Recurrence and budgets.

const pad = (n: number) => String(n).padStart(2, "0");
const daysIn = (year: number, month: number) => new Date(Date.UTC(year, month, 0)).getUTCDate();

/**
 * The next occurrence after `from` for a schedule anchored on `anchor`. Monthly and yearly keep
 * the anchor's day, clamped to the month's length (Jan 31 -> Feb 28/29 -> Mar 31).
 */
export function nextOccurrence(anchor: string, from: string, frequency: Frequency, interval = 1): string {
  const step = Math.max(1, Math.trunc(interval));
  const [ay, am, ad] = anchor.split("-").map(Number);
  if (frequency === "daily" || frequency === "weekly") {
    const days = (frequency === "daily" ? 1 : 7) * step;
    const anchorMs = Date.UTC(ay, am - 1, ad);
    const fromMs = Date.parse(`${from}T00:00:00Z`);
    const n = Math.max(1, Math.floor((fromMs - anchorMs) / (days * 86_400_000)) + 1);
    const next = new Date(anchorMs + n * days * 86_400_000);
    return `${next.getUTCFullYear()}-${pad(next.getUTCMonth() + 1)}-${pad(next.getUTCDate())}`;
  }
  const monthsStep = (frequency === "monthly" ? 1 : 12) * step;
  for (let n = 1; n < 100_000; n += 1) {
    const total = am - 1 + n * monthsStep;
    const year = ay + Math.floor(total / 12);
    const month = (total % 12) + 1;
    const candidate = `${year}-${pad(month)}-${pad(Math.min(ad, daysIn(year, month)))}`;
    if (candidate > from) return candidate;
  }
  throw new Error("schedule out of range");
}

/** Every occurrence date from `start` up to and including `until` (at most `limit`). */
export function occurrences(start: string, until: string, frequency: Frequency, interval = 1, limit = 366): string[] {
  const dates: string[] = [];
  if (start > until) return dates;
  let current = start;
  while (current <= until && dates.length < limit) {
    dates.push(current);
    current = nextOccurrence(start, current, frequency, interval);
  }
  return dates;
}

/** The first and last day of the budget period containing `on`. `monthStartDay` (1–28) shifts months like Suishouji's custom month start. */
export function periodBounds(on: string, period: BudgetPeriod, monthStartDay = 1): { from: string; to: string } {
  const start = Math.min(Math.max(1, Math.trunc(monthStartDay)), 28);
  const [y, m, d] = on.split("-").map(Number);
  if (period === "year") return { from: `${y}-01-01`, to: `${y}-12-31` };
  let year = y;
  let month = m;
  if (d < start) {
    month -= 1;
    if (month === 0) { month = 12; year -= 1; }
  }
  const from = `${year}-${pad(month)}-${pad(start)}`;
  let endYear = year;
  let endMonth = month + 1;
  if (endMonth === 13) { endMonth = 1; endYear += 1; }
  const end = new Date(Date.UTC(endYear, endMonth - 1, start) - 86_400_000);
  return { from, to: `${end.getUTCFullYear()}-${pad(end.getUTCMonth() + 1)}-${pad(end.getUTCDate())}` };
}

export interface BudgetStatus {
  spentMinor: number;
  limitMinor: number;
  remainingMinor: number;
  ratio: number;
  level: "ok" | "warning" | "over";
}

/** Spending against a limit. `warning` from `alertPercent` (default 90, like Suishouji), `over` past 100%. */
export function budgetStatus(spentMinor: number, limitMinor: number, alertPercent = 90): BudgetStatus {
  const ratio = limitMinor > 0 ? spentMinor / limitMinor : spentMinor > 0 ? Infinity : 0;
  const level = ratio > 1 ? "over" : ratio * 100 >= alertPercent ? "warning" : "ok";
  return { spentMinor, limitMinor, remainingMinor: limitMinor - spentMinor, ratio, level };
}
