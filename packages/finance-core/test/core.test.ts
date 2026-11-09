import type { Statement, Transaction } from "@billie/shared-types";
import {
  buildSnapshot, Categorizer, centsToDecimalString, decimalToCents, decodeStatementBytes, ImportError, parseCsv,
  recategorizeUncategorized, resolvePeriod, ruleFor, sha256Hex, transactionsMatchingRule, formatMoney,
} from "../src";

const tx = (id: number, bookedOn: string, amountCents: number, category: Transaction["category"], extra: Partial<Transaction> = {}): Transaction =>
  ({ id, statementId: 1, bookedOn, description: `T${id}`, amountCents, category, taxReview: false, excluded: false, ...extra });

describe("money", () => {
  it("converts without floating point", () => {
    expect(decimalToCents("0.1")).toBe(10);
    expect(decimalToCents("-12.5")).toBe(-1250);
    expect(decimalToCents("-0.00")).toBe(0);
    expect(centsToDecimalString(-1250)).toBe("-12.5");
    expect(centsToDecimalString(10000)).toBe("100.0");
    expect(centsToDecimalString(5)).toBe("0.05");
    expect(formatMoney(-123456, "USD")).toBe("-$1,234.56");
    // 0.1 + 0.2 style drift cannot happen: sums are integers.
    expect([10, 20].reduce((a, b) => a + b)).toBe(30);
  });
});

describe("csv reader", () => {
  it("handles quotes, CRLF, and blank lines like Ruby", () => {
    expect(parseCsv('a,"b ""q"", c"\r\n\r\n1,2\n')).toEqual([["a", 'b "q", c'], ["1", "2"]]);
    expect(parseCsv("a,b\n,\n")).toEqual([["a", "b"], ["", ""]]);
    expect(parseCsv('a\n""\n')).toEqual([["a"], [""]]);
  });
});

describe("file checks", () => {
  const enc = (text: string) => new TextEncoder().encode(text);
  it("accepts UTF-8 CSV and strips the BOM", () => {
    expect(decodeStatementBytes(enc("﻿Date\n"), "s.csv")).toBe("Date\n");
  });
  it.each([
    [enc("x"), "s.txt", "require_csv"],
    [new Uint8Array(), "s.csv", "statement_empty"],
    [new Uint8Array([0xff, 0xfe, 0x41]), "s.csv", "csv_encoding"],
    [enc("a\0b"), "s.csv", "csv_binary"],
    [new Uint8Array(2 * 1024 * 1024 + 1).fill(65), "s.csv", "statement_size_limit"],
  ] as const)("rejects %#", (bytes, name, code) => {
    expect(() => decodeStatementBytes(bytes, name)).toThrow(ImportError);
    try { decodeStatementBytes(bytes, name); } catch (error) { expect((error as ImportError).code).toBe(code); }
  });
  it("hashes identical files identically", async () => {
    expect(await sha256Hex(enc("abc"))).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
});

describe("remembered rules", () => {
  const starbucks = { description: "STARBUCKS STORE #1 SEATTLE", amountCents: -500 };
  it("learned rules win over built-in lists, per direction", () => {
    const rule = ruleFor(starbucks, "Business")!;
    expect(rule).toEqual({ merchantKey: "starbucks store", income: false, category: "Business" });
    const categorizer = new Categorizer([rule]);
    expect(categorizer.categorize("Starbucks Store 99 Portland", -300)).toBe("Business");
    expect(categorizer.categorize("Starbucks Store refund", 300)).toBe("Income");
  });
  it("no rule for Uncategorized or merchant-less descriptions", () => {
    expect(ruleFor(starbucks, "Uncategorized")).toBeNull();
    expect(ruleFor({ description: "#12 34", amountCents: -1 }, "Shopping")).toBeNull();
  });
  it("applies only to Uncategorized rows of the same merchant and direction", () => {
    const rows = [
      tx(1, "2026-01-01", -100, "Uncategorized", { description: "ZED BAKERS 1" }),
      tx(2, "2026-01-02", -100, "Shopping", { description: "ZED BAKERS 2" }),
      tx(3, "2026-01-03", 100, "Uncategorized", { description: "ZED BAKERS 3" }),
      tx(4, "2026-01-04", -100, "Uncategorized", { description: "OTHER PLACE" }),
    ];
    const rule = ruleFor(rows[0], "Food & dining")!;
    expect(transactionsMatchingRule(rows, rule).map((t) => t.id)).toEqual([1]);
    expect(recategorizeUncategorized(rows, [rule])).toEqual([{ id: 1, category: "Food & dining" }, { id: 3, category: "Income" }]);
  });
});

describe("snapshot (Rails Snapshot#to_h)", () => {
  const statements: Statement[] = [
    { id: 1, filename: "a.csv", currency: "USD", sha256: "a", transactionCount: 0, closingBalanceCents: 1000, closingBalanceOn: "2026-01-31", importedAt: "" },
    { id: 2, filename: "b.csv", currency: "USD", sha256: "b", transactionCount: 0, closingBalanceCents: 2500, closingBalanceOn: "2026-02-28", importedAt: "" },
  ];
  const rows = [
    tx(1, "2026-01-02", 250000, "Income"),
    tx(2, "2026-01-05", -165000, "Housing"),
    tx(3, "2026-01-09", -40000, "Transfers"),
    tx(4, "2026-01-20", -1000, "Shopping", { excluded: true }),
    tx(5, "2026-02-03", -2340, "Food & dining", { statementId: 2 }),
    tx(6, "2026-02-04", -999, "Uncategorized", { statementId: 2 }),
    tx(7, "2026-02-05", -5000, "Business", { statementId: 2, taxReview: true }),
  ];

  it("excludes transfers and excluded rows from every total", () => {
    const snap = buildSnapshot({ transactions: rows, statements, period: { startDate: null, endDate: null }, currency: "USD" });
    expect(snap.incomeCents).toBe(250000);
    expect(snap.expensesCents).toBe(165000 + 2340 + 999 + 5000);
    expect(snap.netCents).toBe(250000 - 173339);
    expect(snap.transactionCount).toBe(7);
    expect(snap.statementCount).toBe(2);
    expect(snap.uncategorizedCount).toBe(1);
    expect(snap.taxReviewCount).toBe(1);
    expect(snap.excludedCount).toBe(1);
    expect(snap.transferCount).toBe(1);
    expect(snap.periodStart).toBe("2026-01-02");
    expect(snap.periodEnd).toBe("2026-02-05");
    expect(snap.monthly).toEqual([
      { month: "2026-01-01", incomeCents: 250000, expensesCents: 165000, netCents: 85000 },
      { month: "2026-02-01", incomeCents: 0, expensesCents: 8339, netCents: -8339 },
    ]);
    expect(snap.categories.map((c) => [c.name, c.amountCents])).toEqual([["Housing", 165000], ["Business", 5000], ["Food & dining", 2340], ["Uncategorized", 999]]);
    expect(snap.categories[0].share).toBeCloseTo(165000 / 173339);
    expect(snap.recentTransactions.map((t) => t.id)).toEqual([7, 6, 5, 4, 3, 2, 1]);
    expect([snap.balanceCents, snap.balanceOn]).toEqual([2500, "2026-02-28"]);
  });

  it("filters by period and counts only statements in range", () => {
    const snap = buildSnapshot({ transactions: rows, statements, period: { startDate: "2026-02-01", endDate: "2026-02-28" }, currency: "USD" });
    expect(snap.transactionCount).toBe(3);
    expect(snap.statementCount).toBe(1);
    expect(snap.incomeCents).toBe(0);
  });
});

describe("periods (DashboardPeriod)", () => {
  it.each([
    ["this_month", "2026-03-15", "2026-03-01", "2026-03-31"],
    ["last_month", "2026-03-15", "2026-02-01", "2026-02-28"],
    ["last_month", "2026-01-10", "2025-12-01", "2025-12-31"],
    ["last_30_days", "2026-03-15", "2026-02-14", "2026-03-15"],
    ["this_year", "2026-03-15", "2026-01-01", "2026-12-31"],
    ["last_year", "2026-03-15", "2025-01-01", "2025-12-31"],
  ] as const)("%s from %s", (preset, today, start, end) => {
    expect(resolvePeriod(preset, { today })).toMatchObject({ startDate: start, endDate: end });
  });
  it("validates custom ranges", () => {
    expect(() => resolvePeriod("custom", { today: "2026-01-01", startDate: "2026-02-01", endDate: "2026-01-01" })).toThrow();
    expect(() => resolvePeriod("custom", { today: "2026-01-01", startDate: "2026-02-30", endDate: "2026-03-01" })).toThrow();
  });
});
