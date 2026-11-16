// Contract tests for the shared finance domain (packages/finance-core/schema/financial-schema.json).
// Rails replays the same fixtures in test/services/finance/domain_contract_test.rb.
import schema from "../schema/financial-schema.json";
import kindCases from "../fixtures/kind-cases.json";
import dedupeCases from "../fixtures/dedupe-cases.json";
import scenario from "../fixtures/ledger/appendix2-scenario.json";
import {
  ACCOUNT_TYPES, accountClass, accountTypeFromLegacy, adjustmentFor, balances, budgetStatus, categoryKindFor, countsAs, detectDuplicates, entryProblems,
  inferKind, kindForCategorized, legacyKind, netWorth, nextOccurrence, occurrences, periodBounds, refundableMinor, signedAmount, suspectIncome, totals, transferKind, transferLegs,
  TRANSACTION_KINDS, type AccountType, type LedgerAccount, type LedgerEntry, type TransactionKind,
} from "../src";

const accounts = scenario.accounts as LedgerAccount[];
const entries = scenario.entries as LedgerEntry[];

describe("manifest", () => {
  it("every account type is an asset or a liability; credit cards and loans are liabilities", () => {
    for (const type of ACCOUNT_TYPES) expect(["asset", "liability"]).toContain(accountClass(type));
    expect(accountClass("credit_card")).toBe("liability");
    expect(accountClass("loan")).toBe("liability");
    expect(accountClass("cash")).toBe("asset");
  });

  it("only income, expense and refund count in totals; transfers and card payments never do", () => {
    const counting = TRANSACTION_KINDS.filter((kind) => countsAs(kind) !== null).sort();
    expect(counting).toEqual(["expense", "income", "refund"]);
    expect(countsAs("refund")).toBe("expense");
    expect(categoryKindFor("transfer")).toBeNull();
    expect(categoryKindFor("refund")).toBe("expense");
  });

  it("maps the two legacy account vocabularies onto one enum", () => {
    expect(accountTypeFromLegacy("credit", "web")).toBe("credit_card");
    expect(accountTypeFromLegacy("cash", "web")).toBe("checking");
    expect(accountTypeFromLegacy("credit_card", "local")).toBe("credit_card");
    expect(accountTypeFromLegacy("unknown", "local")).toBe("other");
    expect(accountTypeFromLegacy(null, "web")).toBe("other");
  });

  it("built-in categories in the manifest match shared-types", async () => {
    const { CATEGORIES } = await import("@billie/shared-types");
    expect(schema.builtin_categories.map((c) => c.key)).toEqual([...CATEGORIES]);
  });
});

describe("kind inference (kind-cases.json)", () => {
  it.each(kindCases.cases)("$description $amountMinor on $accountType -> $kind", (c: (typeof kindCases.cases)[number]) => {
    expect(inferKind({ amountMinor: c.amountMinor, accountType: c.accountType as AccountType | null, description: c.description })).toBe(c.kind);
  });

  it.each(kindCases.categorized)("categorized: $description $amountMinor as $category -> $kind", (c: (typeof kindCases.categorized)[number]) => {
    expect(kindForCategorized({ amountMinor: c.amountMinor, accountType: c.accountType as AccountType, description: c.description, category: c.category,
      incomeCategories: new Set((c as { incomeCategories?: string[] }).incomeCategories ?? []) })).toBe(c.kind);
  });

  it("legacy backfill reproduces today's totals and suspect rows are listed, not changed", () => {
    expect(legacyKind({ amountMinor: 3000, category: "Shopping" })).toBe("income");
    expect(legacyKind({ amountMinor: 17000, category: "Transfers" })).toBe("transfer");
    expect(suspectIncome({ kind: "income", amountMinor: 3000, accountType: "credit_card", description: "ZXQ OUTFITTERS" })).toBe("refund");
    expect(suspectIncome({ kind: "income", amountMinor: 200000, accountType: "checking", description: "ZXQ PAYROLL" })).toBeNull();
  });
});

describe("duplicate detection (dedupe-cases.json)", () => {
  it.each(dedupeCases.cases)("$name", (c: (typeof dedupeCases.cases)[number]) => {
    const verdicts = detectDuplicates(c.existing, c.incoming);
    expect(verdicts.map((v) => v.result)).toEqual(c.expected);
  });
});

describe("ledger scenario (Appendix 2)", () => {
  const october = scenario.expected.october;

  it("income and expense follow the kind: refunds net within their category, card payments and transfers never count", () => {
    const result = totals(entries, { from: october.from, to: october.to });
    expect(result.incomeMinor).toBe(october.incomeMinor);
    expect(result.expenseMinor).toBe(october.expenseMinor);
    expect(result.netMinor).toBe(october.netMinor);
    expect(result.expenseByCategory).toEqual(october.expenseByCategory);
    expect(result.incomeByCategory).toEqual(october.incomeByCategory);
    const all = totals(entries);
    expect([all.incomeMinor, all.expenseMinor, all.netMinor]).toEqual([scenario.expected.allTime.incomeMinor, scenario.expected.allTime.expenseMinor, scenario.expected.allTime.netMinor]);
  });

  it("the old sign-based rule would have counted the refund as income", () => {
    const naive = entries.filter((e) => !e.deleted && !e.excluded && e.amountMinor > 0 && e.category !== "Transfers").reduce((s, e) => s + e.amountMinor, 0);
    expect(naive).toBe(scenario.expected.naiveSignBasedIncomeMinor);
    expect(naive).toBeGreaterThan(october.incomeMinor);
  });

  it("balances include transfers and adjustments, exclude deleted rows, and keep excluded rows (hidden from totals only)", () => {
    expect(Object.fromEntries(balances(accounts, entries, "2026-10-31"))).toEqual(scenario.expected["balancesAsOf2026-10-31"]);
    expect(Object.fromEntries(balances(accounts, entries))).toEqual(scenario.expected.balancesAllTime);
  });

  it("net worth = assets - liabilities over accounts included in net worth", () => {
    expect(netWorth(accounts, entries)).toEqual(scenario.expected.netWorthAllTime);
  });

  it("confirmed transfers balance (Σ legs = 0) and partial refunds are capped", () => {
    const byId = new Map(entries.map((e) => [e.id, e]));
    for (const link of scenario.links.filter((l) => l.type !== "refund_of")) expect(byId.get(link.from)!.amountMinor + byId.get(link.to)!.amountMinor).toBe(0);
    expect(refundableMinor(byId.get("t2")!.amountMinor, [3000])).toBe(scenario.expected.refundableOf_t2);
  });
});

describe("manual entry rules", () => {
  it("signs a typed positive amount by kind", () => {
    expect(signedAmount("expense", 1250)).toBe(-1250);
    expect(signedAmount("income", 1250)).toBe(1250);
    expect(signedAmount("refund", 1250)).toBe(1250);
    expect(transferLegs(500)).toEqual({ from: -500, to: 500 });
    expect(transferKind("credit_card")).toBe("card_payment");
    expect(transferKind("savings")).toBe("transfer");
    expect(adjustmentFor(5000, 4250)).toBe(-750);
  });

  it("validates like Rails", () => {
    const base = { kind: "expense" as TransactionKind, amountMinor: 100, occurredOn: "2026-10-01", accountId: 1, categoryKind: "expense" as const };
    expect(entryProblems(base)).toEqual([]);
    expect(entryProblems({ ...base, amountMinor: 0 })).toEqual(["amount_zero"]);
    expect(entryProblems({ ...base, amountMinor: null })).toEqual(["amount_required"]);
    expect(entryProblems({ ...base, amountMinor: 12.5 })).toEqual(["amount_precision"]);
    expect(entryProblems({ ...base, occurredOn: "2026-13-40" })).toEqual(["date_invalid"]);
    expect(entryProblems({ ...base, occurredOn: "2026-02-30" })).toEqual(["date_invalid"]);
    expect(entryProblems({ ...base, occurredOn: "2024-02-29" })).toEqual([]);
    expect(entryProblems({ ...base, accountId: null })).toEqual(["account_required"]);
    expect(entryProblems({ ...base, categoryKind: "income" })).toEqual(["category_kind"]);
    expect(entryProblems({ ...base, kind: "transfer", toAccountId: 1, categoryKind: null })).toEqual(["accounts_same"]);
    expect(entryProblems({ ...base, kind: "refund", amountMinor: 6000, refundOf: { amountMinor: -8000, refundedMinor: 3000 } })).toEqual(["refund_too_large"]);
    expect(entryProblems({ ...base, kind: "refund", refundOf: null })).toEqual(["refund_target_required"]);
    expect(entryProblems({ ...base, kind: "adjustment", amountMinor: 0, categoryKind: null })).toEqual([]);
    expect(entryProblems({ ...base, kind: "bogus" })).toEqual(["kind_invalid"]);
  });
});

describe("recurrence and budgets", () => {
  it("monthly schedules keep the anchor day, clamped to short months", () => {
    expect(occurrences("2026-01-31", "2026-05-31", "monthly")).toEqual(["2026-01-31", "2026-02-28", "2026-03-31", "2026-04-30", "2026-05-31"]);
    expect(nextOccurrence("2026-10-15", "2026-10-15", "weekly")).toBe("2026-10-22");
    expect(nextOccurrence("2026-10-15", "2026-10-20", "daily", 2)).toBe("2026-10-21");
    expect(nextOccurrence("2024-02-29", "2024-02-29", "yearly")).toBe("2025-02-28");
    expect(occurrences("2026-11-01", "2026-10-01", "monthly")).toEqual([]);
  });

  it("budget periods honour a custom month start day", () => {
    expect(periodBounds("2026-10-15", "month")).toEqual({ from: "2026-10-01", to: "2026-10-31" });
    expect(periodBounds("2026-10-03", "month", 10)).toEqual({ from: "2026-09-10", to: "2026-10-09" });
    expect(periodBounds("2026-12-20", "month", 10)).toEqual({ from: "2026-12-10", to: "2027-01-09" });
    expect(periodBounds("2026-10-15", "year")).toEqual({ from: "2026-01-01", to: "2026-12-31" });
  });

  it("warns at 90% and flags spending over the limit", () => {
    expect(budgetStatus(8000, 10000).level).toBe("ok");
    expect(budgetStatus(9000, 10000).level).toBe("warning");
    expect(budgetStatus(10001, 10000).level).toBe("over");
    expect(budgetStatus(10001, 10000).remainingMinor).toBe(-1);
  });
});
