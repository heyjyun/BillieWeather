// Port of app/services/finance/spending_breakdown.rb: the numbers behind the spending charts.
// Only counted spending (amount < 0, not excluded, not Transfers) is used.
//
// Colors follow the category, never its rank in the current view: the SPENDING_SLOTS biggest
// all-time spending categories (Uncategorized aside) each own one chart color, the same on every
// page and in every date range. Everything else is drawn as "Other".
import type { Category, IsoDate, Period, Transaction } from "@billie/shared-types";
import { merchantKey } from "./categorizer";
import { inPeriod, isCounted } from "./snapshot";

export const SPENDING_SLOTS = 7;
export const OTHER_KEY = "__other";
export const MERCHANT_LIMIT = 5;

/** 0..SPENDING_SLOTS-1 for a category with its own color. */
export type SpendingTone = number | "other" | "uncategorized";

export interface SpendingPart {
  key: Category | typeof OTHER_KEY;
  tone: SpendingTone;
  amountCents: number;
  share: number | null;
  /** The categories folded into Other, biggest first. */
  members?: Category[];
}

export interface SpendingMix {
  totalCents: number;
  parts: SpendingPart[];
}

export interface SpendingMonth {
  month: IsoDate;
  totalCents: number;
  segments: Array<{ key: SpendingPart["key"]; tone: SpendingTone; amountCents: number }>;
}

export interface CategoryTrend {
  months: Array<{ month: IsoDate; amountCents: number }>;
  averageCents: number | null;
  latest: { month: IsoDate; amountCents: number } | null;
}

export interface MerchantTotal {
  name: string;
  amountCents: number;
  count: number;
}

type Spend = Pick<Transaction, "bookedOn" | "amountCents" | "category" | "excluded" | "description">;

const isSpending = (transaction: Spend) => isCounted(transaction as Transaction) && transaction.amountCents < 0;
const byAmountThenName = ([a, x]: [string, number], [b, y]: [string, number]) => y - x || (a < b ? -1 : a > b ? 1 : 0);
const monthOf = (date: IsoDate): IsoDate => `${date.slice(0, 7)}-01`;

function totalsByCategory(transactions: readonly Spend[]): Map<Category, number> {
  const totals = new Map<Category, number>();
  for (const transaction of transactions) {
    if (isSpending(transaction)) totals.set(transaction.category, (totals.get(transaction.category) ?? 0) - transaction.amountCents);
  }
  return totals;
}

/** Category names that own a color, in slot order. */
export function spendingPalette(transactions: readonly Spend[]): Category[] {
  return [...totalsByCategory(transactions).entries()]
    .filter(([name]) => name !== "Uncategorized")
    .sort(byAmountThenName)
    .slice(0, SPENDING_SLOTS)
    .map(([name]) => name);
}

export function spendingTone(palette: readonly Category[], name: Category): SpendingTone {
  if (name === "Uncategorized") return "uncategorized";
  const index = palette.indexOf(name);
  return index === -1 ? "other" : index;
}

/** The split of spending in a period: colored categories biggest first, then Other, then Uncategorized. */
export function spendingMix(transactions: readonly Spend[], palette: readonly Category[], period: Pick<Period, "startDate" | "endDate"> = { startDate: null, endDate: null }): SpendingMix {
  const totals = totalsByCategory(transactions.filter((transaction) => inPeriod(transaction as Transaction, period)));
  const totalCents = [...totals.values()].reduce((sum, amount) => sum + amount, 0);
  const share = (amount: number) => (totalCents > 0 ? amount / totalCents : null);
  const entries = [...totals.entries()].sort(byAmountThenName);
  const parts: SpendingPart[] = entries
    .filter(([name]) => palette.includes(name))
    .map(([name, amountCents]) => ({ key: name, tone: spendingTone(palette, name), amountCents, share: share(amountCents) }));
  const rest = entries.filter(([name]) => !palette.includes(name) && name !== "Uncategorized");
  if (rest.length > 0) {
    const amountCents = rest.reduce((sum, [, amount]) => sum + amount, 0);
    parts.push({ key: OTHER_KEY, tone: "other", amountCents, share: share(amountCents), members: rest.map(([name]) => name) });
  }
  const uncategorized = totals.get("Uncategorized");
  if (uncategorized) parts.push({ key: "Uncategorized", tone: "uncategorized", amountCents: uncategorized, share: share(uncategorized) });
  return { totalCents, parts };
}

/** Consecutive months ending with the latest month that has counted transactions. */
function monthWindow(transactions: readonly Spend[], months: number): IsoDate[] {
  let latest: IsoDate | null = null;
  for (const transaction of transactions) {
    if (isCounted(transaction as Transaction) && (latest === null || transaction.bookedOn > latest)) latest = transaction.bookedOn;
  }
  if (latest === null) return [];
  const year = Number(latest.slice(0, 4));
  const month = Number(latest.slice(5, 7)) - 1;
  return Array.from({ length: months }, (_, offset) => {
    const date = new Date(Date.UTC(year, month - (months - 1 - offset), 1));
    return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-01`;
  });
}

/** Spending per month for the latest `months` months, stacked in one order (slot order, Other, Uncategorized). */
export function spendingByMonth(transactions: readonly Spend[], palette: readonly Category[], months = 6): SpendingMonth[] {
  const window = monthWindow(transactions, months);
  const sums = new Map<IsoDate, Map<string, number>>(window.map((month) => [month, new Map()]));
  for (const transaction of transactions) {
    const month = sums.get(monthOf(transaction.bookedOn));
    if (!month || !isSpending(transaction)) continue;
    const key = palette.includes(transaction.category) ? transaction.category : transaction.category === "Uncategorized" ? "Uncategorized" : OTHER_KEY;
    month.set(key, (month.get(key) ?? 0) - transaction.amountCents);
  }
  const order = [...palette, OTHER_KEY, "Uncategorized"];
  return window.map((month) => {
    const amounts = sums.get(month)!;
    const segments = order.flatMap((key) => {
      const amountCents = amounts.get(key) ?? 0;
      return amountCents > 0 ? [{ key, tone: key === OTHER_KEY ? ("other" as const) : spendingTone(palette, key), amountCents }] : [];
    });
    return { month, totalCents: segments.reduce((sum, segment) => sum + segment.amountCents, 0), segments };
  });
}

/** One category over time; the average counts from its first month in the window. */
export function categoryTrend(transactions: readonly Spend[], name: Category, months = 12): CategoryTrend {
  const window = monthWindow(transactions, months);
  if (window.length === 0) return { months: [], averageCents: null, latest: null };
  const sums = new Map<IsoDate, number>(window.map((month) => [month, 0]));
  for (const transaction of transactions) {
    const month = monthOf(transaction.bookedOn);
    if (transaction.category === name && isSpending(transaction) && sums.has(month)) sums.set(month, sums.get(month)! - transaction.amountCents);
  }
  const rows = window.map((month) => ({ month, amountCents: sums.get(month)! }));
  const first = rows.findIndex((row) => row.amountCents > 0);
  const active = first === -1 ? [] : rows.slice(first);
  const averageCents = active.length > 0 ? Math.round(active.reduce((sum, row) => sum + row.amountCents, 0) / active.length) : null;
  return { months: rows, averageCents, latest: rows[rows.length - 1] };
}

/** "starbucks store" -> "Starbucks Store" (SpendingBreakdown.merchant_name). */
export const merchantName = (key: string) => key.split(" ").filter(Boolean).map((word) => word[0].toUpperCase() + word.slice(1)).join(" ");

/** Where a category's money went, biggest merchants first. */
export function topMerchants(transactions: readonly Spend[], name: Category, limit = MERCHANT_LIMIT): MerchantTotal[] {
  const totals = new Map<string, { amountCents: number; count: number }>();
  for (const transaction of transactions) {
    if (transaction.category !== name || !isSpending(transaction)) continue;
    const key = merchantKey(transaction.description) ?? transaction.description.trim().toLowerCase();
    const row = totals.get(key) ?? { amountCents: 0, count: 0 };
    row.amountCents -= transaction.amountCents;
    row.count += 1;
    totals.set(key, row);
  }
  return [...totals.entries()]
    .sort(([a, x], [b, y]) => y.amountCents - x.amountCents || (a < b ? -1 : a > b ? 1 : 0))
    .slice(0, limit)
    .map(([key, row]) => ({ name: merchantName(key), ...row }));
}
