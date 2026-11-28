// Accounts & Assets model: grouping, statuses, per-currency totals, search / filter / sort, preferences.
import { describe, expect, it } from "vitest";
import {
  DEFAULT_PREFS, NO_FILTERS, buildTree, groupOf, matches, moveWithinType, readPrefs, statusOf, summarize, totals, type AccountRow,
} from "../src/accounts/model";
import { accountMessages } from "../src/accounts/messages";

const TYPES = ["checking", "savings", "cash", "payment_app", "investment", "receivable", "credit_card", "loan", "other"] as const;
const today = "2026-11-28";
let next = 0;
function row(patch: Partial<AccountRow> = {}): AccountRow {
  next += 1;
  return {
    id: String(next), name: `Account ${next}`, institution: null, last4: null, type: "checking", liability: false, currency: "USD", balance: 10_000,
    archived: false, includeInNetWorth: true, origin: "manual", confirmedOn: today, confirmedBy: "manual", lastEntryOn: null, statementDiffers: false,
    creditLimit: null, sortOrder: next, canDelete: true, ...patch,
  };
}
const labels = { type: Object.fromEntries(TYPES.map((t) => [t, t])), group: accountMessages.en.groups };
const tree = (rows: AccountRow[], showEmpty = false) => buildTree(rows, { typeOrder: TYPES, primary: "USD", showEmpty, sort: DEFAULT_PREFS.sort, locale: "en",
  groupNames: accountMessages.en.groups, typeNames: labels.type });

describe("account groups", () => {
  it("maps every existing account type into the four agreed groups", () => {
    expect(TYPES.map((type) => groupOf({ type, liability: type === "credit_card" || type === "loan" }))).toEqual(
      ["liquid", "liquid", "liquid", "liquid", "financial", "financial", "liabilities", "liabilities", "other"]);
  });
  it("hides empty groups unless asked, and splits a group by type only when it holds several types", () => {
    const rows = [row({ type: "checking" }), row({ type: "savings" }), row({ type: "investment" })];
    const nodes = tree(rows);
    expect(nodes.map((n) => n.key)).toEqual(["liquid", "financial"]);
    expect(nodes[0].children.map((n) => n.key)).toEqual(["liquid/checking", "liquid/savings"]);
    expect(nodes[1].children).toEqual([]);
    expect(nodes[1].rows).toHaveLength(1);
    expect(tree(rows, true).map((n) => n.key)).toEqual(["liquid", "financial", "liabilities", "other"]);
  });
  it("scales to many accounts", () => {
    const many = Array.from({ length: 150 }, (_, i) => row({ type: TYPES[i % TYPES.length], liability: ["credit_card", "loan"].includes(TYPES[i % TYPES.length]) }));
    const nodes = tree(many);
    expect(nodes.reduce((sum, n) => sum + n.count, 0)).toBe(150);
  });
});

describe("totals never mix currencies and never count an unknown balance as zero", () => {
  it("keeps one total per currency with the book currency first", () => {
    const result = totals([row({ currency: "EUR", balance: 28_000 }), row({ balance: 10_000 }), row({ balance: null }), row({ balance: 5_000 })], "USD");
    expect(result).toEqual([{ currency: "USD", amount: 15_000, unknown: 1 }, { currency: "EUR", amount: 28_000, unknown: 0 }]);
  });
  it("shows a dash, not zero, when no balance in a currency is known", () => {
    expect(totals([row({ balance: null })], "USD")).toEqual([{ currency: "USD", amount: null, unknown: 1 }]);
  });
  it("shows liabilities as the positive amount owed", () => {
    expect(totals([row({ type: "credit_card", liability: true, balance: -21_540 })], "USD")[0].amount).toBe(21_540);
  });
  it("summarizes with the dashboard position over known balances and counts what it leaves out", () => {
    const summary = summarize("USD", { extraCash: null, cashOverride: null, holdings: [
      { type: "checking", liability: false, included: true, archived: false, balance: 500_000 },
      { type: "investment", liability: false, included: true, archived: false, balance: 1_000_000 },
      { type: "credit_card", liability: true, included: true, archived: false, balance: -30_000 },
      { type: "other", liability: false, included: true, archived: false, balance: null },
      // Archived but included: counts in net worth, not in liquid assets.
      { type: "savings", liability: false, included: true, archived: true, balance: 20_000 },
      { type: "savings", liability: false, included: false, archived: false, balance: 99_900 },
    ] });
    expect(summary).toEqual({ currency: "USD", assets: 1_520_000, liabilities: 30_000, worth: 1_490_000, available: 599_900, unknown: 1 });
  });
});

describe("status uses real balance dates", () => {
  it("distinguishes unknown, unconfirmed, current and out-of-date balances", () => {
    expect(statusOf(row({ balance: null }), today)).toBe("unknown");
    expect(statusOf(row({ confirmedOn: null, confirmedBy: null }), today)).toBe("undated");
    expect(statusOf(row({ confirmedOn: "2026-11-01" }), today)).toBe("manual");
    expect(statusOf(row({ confirmedOn: "2026-10-01" }), today)).toBe("stale");
    expect(statusOf(row({ confirmedOn: "2026-10-20", confirmedBy: "statement" }), today)).toBe("statement");
    expect(statusOf(row({ statementDiffers: true }), today)).toBe("differs");
    expect(statusOf(row({ archived: true, balance: null }), today)).toBe("archived");
  });
});

describe("search, filter and sort", () => {
  const rows = [
    row({ name: "Everyday", institution: "Synthetic Bank", last4: "4821" }),
    row({ name: "Card", type: "credit_card", liability: true, institution: "Synthetic Card Co", last4: "1005", balance: -8_300, origin: "imported" }),
    row({ name: "Wallet", type: "cash", currency: "EUR", balance: 28_000 }),
  ];
  const find = (filters: Partial<typeof NO_FILTERS>) => rows.filter((r) => matches(r, { ...NO_FILTERS, ...filters }, today, labels)).map((r) => r.name);
  it("searches name, institution, last four digits, type, category and currency", () => {
    expect(find({ query: "synthetic" })).toEqual(["Everyday", "Card"]);
    expect(find({ query: "••4821" })).toEqual(["Everyday"]);
    expect(find({ query: "eur" })).toEqual(["Wallet"]);
    expect(find({ query: "liabilities" })).toEqual(["Card"]);
    expect(find({ query: "credit_card 1005" })).toEqual(["Card"]);
  });
  it("filters by class, currency and origin", () => {
    expect(find({ accountClass: "liability" })).toEqual(["Card"]);
    expect(find({ currency: "EUR" })).toEqual(["Wallet"]);
    expect(find({ origin: "imported" })).toEqual(["Card"]);
  });
  it("sorts balances within a currency only and keeps unknown balances last", () => {
    const sorted = buildTree([row({ balance: 5 }), row({ balance: null }), row({ balance: 9 }), row({ balance: 1, currency: "EUR" })],
      { typeOrder: TYPES, primary: "USD", showEmpty: false, sort: { key: "balance", dir: "desc" }, locale: "en", groupNames: accountMessages.en.groups, typeNames: labels.type });
    expect(sorted[0].rows.map((r) => [r.currency, r.balance])).toEqual([["EUR", 1], ["USD", 9], ["USD", 5], ["USD", null]]);
  });
});

describe("reordering", () => {
  it("moves an account among its own type and leaves other types in place", () => {
    const [a, b, c, d] = [row({ type: "checking" }), row({ type: "savings" }), row({ type: "checking" }), row({ type: "checking" })];
    expect(moveWithinType([a, b, c, d], d.id, -1)).toEqual([a.id, b.id, d.id, c.id]);
    expect(moveWithinType([a, b, c, d], a.id, { before: d.id })).toEqual([c.id, b.id, a.id, d.id]);
    expect(moveWithinType([a, b, c, d], a.id, -1)).toBeNull();
  });
});

describe("preferences", () => {
  it("falls back to defaults for missing, corrupt or foreign values", () => {
    expect(readPrefs(null)).toEqual(DEFAULT_PREFS);
    expect(readPrefs("{")).toEqual(DEFAULT_PREFS);
    const prefs = readPrefs(JSON.stringify({ v: 1, order: ["status", "bogus", "institution"], hidden: ["balance", "type"], widths: { name: 9000, type: 120 },
      density: "comfortable", sort: { key: "balance", dir: "desc" }, archived: "everything" }));
    expect(prefs.order.slice(0, 2)).toEqual(["status", "institution"]);
    expect(prefs.order).toHaveLength(7);
    expect(prefs.hidden).toEqual(["type"]);
    expect(prefs.widths).toEqual({ type: 120 });
    expect(prefs.density).toBe("comfortable");
    expect(prefs.sort).toEqual({ key: "balance", dir: "desc" });
    expect(prefs.archived).toBe("active");
  });
  it("has the same message keys in every language", () => {
    const shape = (value: unknown): unknown => (value && typeof value === "object" ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, shape(v)])) : typeof value);
    for (const [, messages] of Object.entries(accountMessages)) expect(shape(messages)).toEqual(shape(accountMessages.en));
  });
});
