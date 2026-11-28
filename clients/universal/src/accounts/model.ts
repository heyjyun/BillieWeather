// Accounts & Assets table: the platform-neutral model shared by Rails (public/accounts-table.js)
// and the local client. Pure functions only; no React, no storage access except through arguments.
//
// Accounting rules (docs/architecture/finance-domain-spec.md, "Accounts & Assets"):
// - Amounts are integer minor units in the account's own currency. Currencies are never added
//   together and never converted: every subtotal and summary is per currency.
// - A balance that is not known is `null`, never 0. Totals over known balances say how many
//   balances they leave out.
// - Liabilities are stored with the ledger sign (money owed is negative) and shown as the
//   positive amount owed.
// - Net worth, assets and liabilities count every account marked "include in net worth",
//   archived or not; archiving only hides an account. Liquid assets count active accounts only.
import { group as overviewGroup, position, type Holding, type Position } from "../overview/model";

export const GROUPS = ["liquid", "financial", "liabilities", "other"] as const;
export type Group = (typeof GROUPS)[number];

export interface AccountRow {
  id: string;
  name: string;
  institution: string | null;
  last4: string | null;
  type: string;
  liability: boolean;
  currency: string;
  /** Ledger-signed balance in minor units, or null when it is not known. */
  balance: number | null;
  archived: boolean;
  includeInNetWorth: boolean;
  /** "manual": created by hand; "imported": first seen on a statement. */
  origin: "manual" | "imported";
  /** The latest date the balance was confirmed: a dated opening balance, an adjustment, or a matching statement. */
  confirmedOn: string | null;
  confirmedBy: "manual" | "statement" | null;
  /** The latest entry date in the account (not the same thing as a confirmed balance). */
  lastEntryOn: string | null;
  /** The latest statement shows a balance that differs from the ledger on that date. */
  statementDiffers: boolean;
  creditLimit: number | null;
  sortOrder: number;
  canDelete: boolean;
}

export type Status = "archived" | "unknown" | "differs" | "undated" | "stale" | "manual" | "statement";
/** Days after which a confirmed balance is called out of date, by how it is kept up to date. */
export const STALE_DAYS = { manual: 30, statement: 45 } as const;

export const COLUMNS = ["institution", "last4", "type", "currency", "balance", "asOf", "status"] as const;
export type Column = (typeof COLUMNS)[number];
/** The account name, the balance and the actions menu are always shown. */
export const REQUIRED: readonly Column[] = ["balance"];
export const SORT_KEYS = ["custom", "name", "institution", "balance", "updated", "type"] as const;
export type SortKey = (typeof SORT_KEYS)[number];

export interface Prefs {
  v: 1;
  order: Column[];
  hidden: Column[];
  widths: Partial<Record<Column | "name", number>>;
  density: "compact" | "comfortable";
  collapsed: string[];
  showEmpty: boolean;
  hideBalances: boolean;
  sort: { key: SortKey; dir: "asc" | "desc" };
  archived: "active" | "archived" | "all";
}
export const DEFAULT_PREFS: Prefs = {
  v: 1, order: [...COLUMNS], hidden: [], widths: {}, density: "compact", collapsed: [], showEmpty: false,
  hideBalances: false, sort: { key: "custom", dir: "asc" }, archived: "active",
};

export interface Filters {
  query: string;
  group: Group | "";
  accountClass: "asset" | "liability" | "";
  institution: string;
  currency: string;
  origin: "manual" | "imported" | "";
  status: Status | "";
}
export const NO_FILTERS: Filters = { query: "", group: "", accountClass: "", institution: "", currency: "", origin: "", status: "" };

/** `amount` is null when no balance in this currency is known. */
export interface Total { currency: string; amount: number | null; unknown: number }
export interface Node {
  key: string;
  kind: "group" | "type";
  name: string;
  rows: AccountRow[];
  children: Node[];
  count: number;
  totals: Total[];
}

export function groupOf(row: Pick<AccountRow, "liability" | "type">): Group {
  // The overview's grouping never returns "fixed" for an account: fixed assets live in their own module.
  return overviewGroup({ type: row.type, liability: row.liability } as Holding) as Group;
}

/** Days between two ISO dates (b - a). */
export function daysBetween(a: string, b: string) {
  return Math.round((Date.parse(b + "T00:00:00Z") - Date.parse(a + "T00:00:00Z")) / 86_400_000);
}

export function statusOf(row: AccountRow, today: string): Status {
  if (row.archived) return "archived";
  if (row.balance === null) return "unknown";
  if (row.statementDiffers) return "differs";
  if (!row.confirmedOn || !row.confirmedBy) return "undated";
  return daysBetween(row.confirmedOn, today) > STALE_DAYS[row.confirmedBy] ? "stale" : row.confirmedBy;
}

/** The amount as shown: what is owed for a liability, the balance otherwise. */
export function shown(row: Pick<AccountRow, "liability" | "balance">) {
  return row.balance === null ? null : row.liability ? -row.balance || 0 : row.balance;
}

export function totals(rows: AccountRow[], primary: string): Total[] {
  const out = new Map<string, Total>();
  for (const row of rows) {
    const total = out.get(row.currency) ?? { currency: row.currency, amount: null, unknown: 0 };
    const amount = shown(row);
    if (amount === null) total.unknown += 1;
    else total.amount = (total.amount ?? 0) + amount;
    out.set(row.currency, total);
  }
  return [...out.values()].sort((a, b) => (a.currency === primary ? -1 : b.currency === primary ? 1 : a.currency.localeCompare(b.currency)));
}

export function matches(row: AccountRow, filters: Filters, today: string, labels: { type: Record<string, string>; group: Record<Group, string> }) {
  if (filters.group && groupOf(row) !== filters.group) return false;
  if (filters.accountClass && (row.liability ? "liability" : "asset") !== filters.accountClass) return false;
  if (filters.institution && (row.institution ?? "") !== filters.institution) return false;
  if (filters.currency && row.currency !== filters.currency) return false;
  if (filters.origin && row.origin !== filters.origin) return false;
  if (filters.status && statusOf(row, today) !== filters.status) return false;
  const words = filters.query.toLocaleLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const haystack = [row.name, row.institution, row.last4, row.type, labels.type[row.type], labels.group[groupOf(row)], row.currency]
    .filter(Boolean).join(" ").toLocaleLowerCase();
  return words.every((word) => haystack.includes(word.replace(/^[•.*]+/, "")));
}

export function compare(key: SortKey, dir: "asc" | "desc", typeOrder: readonly string[], locale: string) {
  const text = new Intl.Collator(locale, { sensitivity: "base", numeric: true });
  const sign = dir === "desc" ? -1 : 1;
  const missingLast = <T,>(a: T | null, b: T | null, by: (x: T, y: T) => number) =>
    a === null && b === null ? 0 : a === null ? 1 : b === null ? -1 : sign * by(a, b);
  return (a: AccountRow, b: AccountRow): number => {
    let result = 0;
    switch (key) {
      case "name": result = sign * text.compare(a.name, b.name); break;
      case "institution": result = missingLast(a.institution, b.institution, text.compare); break;
      // Balances are only compared within one currency: different currencies sort by code first.
      case "balance": result = a.currency.localeCompare(b.currency) || missingLast(shown(a), shown(b), (x, y) => x - y); break;
      case "updated": result = missingLast(a.confirmedOn, b.confirmedOn, (x, y) => x.localeCompare(y)); break;
      case "type": result = sign * (typeOrder.indexOf(a.type) - typeOrder.indexOf(b.type)); break;
      default: result = sign * (a.sortOrder - b.sortOrder);
    }
    return result || a.sortOrder - b.sortOrder || a.id.localeCompare(b.id);
  };
}

/**
 * Primary groups, each with one child per account type when the group holds more than one type.
 * Nodes are generic (`children` may nest further), so deeper user-defined levels can be added
 * without changing the renderer.
 */
export function buildTree(rows: AccountRow[], options: { typeOrder: readonly string[]; primary: string; showEmpty: boolean;
  sort: Prefs["sort"]; locale: string; groupNames: Record<Group, string>; typeNames: Record<string, string> }): Node[] {
  const order = compare(options.sort.key, options.sort.dir, options.typeOrder, options.locale);
  return GROUPS.flatMap((key): Node[] => {
    const inGroup = rows.filter((row) => groupOf(row) === key).sort(order);
    if (!inGroup.length && !options.showEmpty) return [];
    const types = options.typeOrder.filter((type) => inGroup.some((row) => row.type === type));
    const children = types.length > 1
      ? types.map((type): Node => {
          const typed = inGroup.filter((row) => row.type === type);
          return { key: `${key}/${type}`, kind: "type", name: options.typeNames[type] ?? type, rows: typed, children: [], count: typed.length, totals: totals(typed, options.primary) };
        })
      : [];
    return [{ key, kind: "group", name: options.groupNames[key], rows: children.length ? [] : inGroup, children, count: inGroup.length, totals: totals(inGroup, options.primary) }];
  });
}

export interface Summary {
  currency: string;
  assets: number | null;
  liabilities: number | null;
  worth: number | null;
  available: number | null;
  /** Accounts counted in net worth whose balance is not known: left out of these totals, not counted as 0. */
  unknown: number;
}

/** The dashboard's position() over known balances only, with the number of balances left out. */
export function summarize(currency: string, p: Position): Summary {
  const unknown = p.holdings.filter((h) => h.included && h.balance === null).length;
  const known = { ...p, holdings: p.holdings.filter((h) => h.balance !== null) };
  const { assets, liabilities, worth, available } = position(known);
  const clean = (value: number | null) => (value === null ? null : value || 0); // never show "-0.00"
  return { currency, assets: clean(assets), liabilities: clean(liabilities), worth: clean(worth), available: clean(available), unknown };
}

const isColumn = (value: unknown): value is Column => typeof value === "string" && (COLUMNS as readonly string[]).includes(value);

/** Reads saved preferences, keeping only valid values; anything unknown falls back to the default. */
export function readPrefs(raw: string | null): Prefs {
  let saved: Partial<Prefs> = {};
  try { saved = raw ? JSON.parse(raw) : {}; } catch { saved = {}; }
  if (!saved || typeof saved !== "object" || saved.v !== 1) return structuredClone(DEFAULT_PREFS);
  const order = Array.isArray(saved.order) ? [...new Set(saved.order.filter(isColumn))] : [];
  const widths: Prefs["widths"] = {};
  for (const [key, value] of Object.entries(saved.widths ?? {})) {
    if ((key === "name" || isColumn(key)) && typeof value === "number" && value >= 48 && value <= 640) widths[key as Column] = Math.round(value);
  }
  const sortKey = saved.sort && (SORT_KEYS as readonly string[]).includes(saved.sort.key) ? saved.sort.key : "custom";
  return {
    v: 1,
    order: [...order, ...COLUMNS.filter((c) => !order.includes(c))],
    hidden: Array.isArray(saved.hidden) ? [...new Set(saved.hidden.filter(isColumn))].filter((c) => !REQUIRED.includes(c)) : [],
    widths,
    density: saved.density === "comfortable" ? "comfortable" : "compact",
    collapsed: Array.isArray(saved.collapsed) ? saved.collapsed.filter((k): k is string => typeof k === "string").slice(0, 200) : [],
    showEmpty: saved.showEmpty === true,
    hideBalances: saved.hideBalances === true,
    sort: { key: sortKey, dir: saved.sort?.dir === "desc" ? "desc" : "asc" },
    archived: saved.archived === "archived" || saved.archived === "all" ? saved.archived : "active",
  };
}

/** New full order of account ids after moving `id` one step (or to `target`) among the rows of its type. */
export function moveWithinType(rows: AccountRow[], id: string, step: -1 | 1 | { before: string }): string[] | null {
  const all = [...rows].sort((a, b) => a.sortOrder - b.sortOrder || a.id.localeCompare(b.id));
  const moving = all.find((row) => row.id === id);
  if (!moving) return null;
  const siblings = all.filter((row) => row.type === moving.type && row.archived === moving.archived);
  const from = siblings.indexOf(moving);
  let to: number;
  if (typeof step === "object") {
    const target = siblings.findIndex((row) => row.id === step.before);
    if (target < 0) return null;
    to = target > from ? target - 1 : target;
  } else to = from + step;
  if (to < 0 || to >= siblings.length || to === from) return null;
  const reordered = [...siblings];
  reordered.splice(from, 1);
  reordered.splice(to, 0, moving);
  // Each slot that held a sibling keeps holding one, so other types keep their places.
  let next = 0;
  return all.map((row) => (row.type === moving.type && row.archived === moving.archived ? reordered[next++] : row).id);
}
