import type { Period } from "@billie/shared-types";
import { nextOccurrence, type Frequency } from "@billie/finance-core";

export const widgets = ["trend", "spending", "forecast", "accounts", "bills", "recent", "insight"] as const;
export const metrics = [
  "worth",
  "available",
  "income",
  "expenses",
  "assets",
  "liabilities",
  "net",
  "savings",
  "fixed",
  "due",
  "budget",
] as const;
export type Widget = (typeof widgets)[number];
export type Metric = (typeof metrics)[number];
export type Scale = "daily" | "weekly" | "monthly" | "yearly";
export type Group = "liquid" | "financial" | "fixed" | "liabilities" | "other";
export type Action =
  | "transactions"
  | "categories"
  | "accounts"
  | "addAccount"
  | "addEntry"
  | "addSync"
  | "import"
  | "forecast"
  | "insight"
  | "bills"
  | "budget"
  | "report";
export interface Scope {
  currency: string;
  account: string;
  period: Period;
}
export interface AccountChoice {
  id: string;
  name: string;
  currency: string;
}
export interface Context {
  locale: string;
  today: string;
  greeting?: string;
  owner: string;
  ledger: string;
  ledgers: { id: string; name: string }[];
  currency: string;
  currencies: string[];
  accounts: AccountChoice[];
  initial?: Scope;
}
export interface Day {
  date: string;
  income: number;
  expenses: number;
  counted: boolean;
}
export interface Holding {
  type: string;
  liability: boolean;
  included: boolean;
  archived: boolean;
  balance: number | null;
}
export interface Position {
  holdings: Holding[];
  extraCash: number | null;
  cashOverride: number | null;
}
export interface Part {
  path: { name: string; label: string }[];
  amount: number;
}
export interface Entry {
  id: number;
  date: string;
  name: string;
  category: string;
  account: string | null;
  amount: number;
}
export interface Bill {
  name: string;
  date: string;
  account: string;
  amount: number;
}
export interface Projection {
  date: string;
  balance: number;
}
export interface Sources {
  flow: () => Promise<Day[]>;
  position: () => Promise<Position>;
  spending: () => Promise<Part[]>;
  recent: () => Promise<Entry[]>;
  bills: () => Promise<Bill[]>;
  budget: () => Promise<number | null>;
  insight: () => Promise<{ text: string; date: string } | null>;
  forecast: () => Promise<Projection[]>;
}
export type Activity = "income" | "spending" | "counted";
export interface Host {
  context: Context;
  sources: (scope: Scope) => Sources;
  navigate: (action: Action, scope: Scope, category?: string, activity?: Activity) => void;
  switchLedger?: (id: string) => Promise<void>;
  scopeChanged?: (scope: Scope) => void;
}
export const dateMs = (day: string) => Date.parse(day + "T00:00:00Z");
export const shift = (day: string, n: number) => new Date(dateMs(day) + n * 86400000).toISOString().slice(0, 10);
export const within = (date: string, p: Pick<Period, "startDate" | "endDate">) =>
  (!p.startDate || date >= p.startDate) && (!p.endDate || date <= p.endDate);

export function previous(p: Period): Period | null {
  if (!p.startDate || !p.endDate) return null;
  const endDate = shift(p.startDate, -1);
  let startDate = shift(endDate, -(dateMs(p.endDate) - dateMs(p.startDate)) / 86400000);
  if (["this_month", "last_month"].includes(p.preset)) startDate = endDate.slice(0, 7) + "-01";
  if (["this_year", "last_year"].includes(p.preset)) startDate = endDate.slice(0, 4) + "-01-01";
  return { preset: "custom", startDate, endDate };
}

export function totals(days: Day[], p: Period) {
  const rows = days.filter((day) => within(day.date, p));
  if (!rows.length) return null;
  const income = rows.reduce((sum, r) => sum + r.income, 0);
  const expenses = rows.reduce((sum, r) => sum + r.expenses, 0);
  const net = income - expenses;
  return { income, expenses, net, savings: income > 0 ? net / income : null };
}

export function scaleFor(days: Day[], p: Period): Scale {
  const span =
    (dateMs(p.endDate ?? days.at(-1)?.date ?? "") - dateMs(p.startDate ?? days[0]?.date ?? "")) / 86400000;
  return span > 365 * 3 ? "yearly" : span > 100 ? "monthly" : span > 20 ? "weekly" : "daily";
}
export function buckets(days: Day[], p: Period, scale: Scale) {
  const out = new Map<string, Day>();
  for (const day of days) {
    if (!within(day.date, p)) continue;
    let date = day.date;
    if (scale === "weekly") date = shift(date, -((new Date(dateMs(date)).getUTCDay() + 6) % 7));
    if (scale === "monthly") date = date.slice(0, 7) + "-01";
    if (scale === "yearly") date = date.slice(0, 4) + "-01-01";
    const row = out.get(date) ?? { date, income: 0, expenses: 0, counted: false };
    row.income += day.income;
    row.expenses += day.expenses;
    row.counted ||= day.counted;
    out.set(date, row);
  }
  return [...out.values()].sort((a, b) => a.date.localeCompare(b.date));
}

export function group(h: Holding): Group {
  if (h.liability) return "liabilities";
  if (["checking", "savings", "cash", "payment_app"].includes(h.type)) return "liquid";
  if (["investment", "receivable"].includes(h.type)) return "financial";
  return "other";
}
function balance(rows: Holding[]) {
  return rows.some((r) => r.balance === null) ? null : rows.reduce((s, r) => s + r.balance!, 0);
}
// A user-entered cash snapshot covers active liquid balances. Reuse it for net worth
// only when those accounts have the same inclusion scope; it already includes extra cash.
function netWorthCash(p: Position) {
  if (p.holdings.some((h) => group(h) === "liquid" && (h.archived || !h.included))) return null;
  return p.cashOverride;
}
export function groupBalance(p: Position, key: Group) {
  const rows = p.holdings.filter((h) => h.included && group(h) === key);
  const override = key === "liquid" ? netWorthCash(p) : null;
  if (override !== null) return override;
  const extra = key === "liquid" ? p.extraCash : null;
  if (!rows.length && extra === null) return null;
  const value = balance(rows);
  return value === null ? null : (key === "liabilities" ? -value : value) + (extra ?? 0);
}
export function position(p: Position) {
  const included = p.holdings.filter((h) => h.included);
  const liquid = p.holdings.filter((h) => !h.archived && group(h) === "liquid");
  const cash = balance(liquid);
  const available =
    p.cashOverride ??
    ((liquid.length || p.extraCash !== null) && cash !== null ? cash + (p.extraCash ?? 0) : null);
  const override = netWorthCash(p);
  const extra = override ?? p.extraCash;
  const hasPosition = included.length > 0 || extra !== null;
  const assetBalance = balance(
    included.filter((h) => !h.liability && (override === null || group(h) !== "liquid")),
  );
  const assets = hasPosition && assetBalance !== null ? assetBalance + (extra ?? 0) : null;
  const debts = hasPosition ? balance(included.filter((h) => h.liability)) : null;
  const liabilities = debts === null ? null : -debts;
  const worth = assets === null || liabilities === null ? null : assets - liabilities;
  return { available, assets, liabilities, worth, fixed: null };
}
export function schedule(
  start: string,
  next: string | null,
  end: string | null,
  frequency: Frequency,
  interval: number,
  today: string,
  horizon = 90,
) {
  const from = [start, next ?? start, today].sort().at(-1)!;
  let date = from === start ? start : nextOccurrence(start, shift(from, -1), frequency, interval);
  const until = shift(today, horizon);
  const dates: string[] = [];
  while (date <= until && (!end || date <= end)) {
    dates.push(date);
    date = nextOccurrence(start, date, frequency, interval);
  }
  return dates;
}
/** Local counterpart to CashFlowForecast's historical-average engine. */
export function project(days: Day[], opening: number | null, today: string): Projection[] {
  const history = days.filter((d) => d.counted && d.date >= shift(today, -89) && d.date <= today);
  if (
    opening === null ||
    history.length < 3 ||
    dateMs(history.at(-1)!.date) - dateMs(history[0].date) < 13 * 86400000
  )
    return [];
  const elapsed = (dateMs(today) - dateMs(history[0].date)) / 86400000 + 1;
  const daily = history.reduce((s, r) => s + r.income - r.expenses, 0) / elapsed;
  return Array.from({ length: 91 }, (_, n) => ({
    date: shift(today, n),
    balance: Math.round(opening + daily * n),
  }));
}
