// Same cases as test/services/finance/spending_breakdown_test.rb.
import type { Transaction } from "@billie/shared-types";
import { categoryTrend, OTHER_KEY, spendingByMonth, spendingMix, spendingPalette, spendingTone, topMerchants } from "../src";

let nextId = 1;
const tx = (amountCents: number, category: string, bookedOn: string, description = `${category} purchase`, excluded = false): Transaction =>
  ({ id: nextId++, statementId: 1, bookedOn, description, amountCents, category, taxReview: false, excluded });
const spend = (dollars: number, category: string, bookedOn: string, description?: string, excluded = false) => tx(-dollars * 100, category, bookedOn, description, excluded);

describe("spending breakdown", () => {
  it("gives the biggest spending categories a color in every period; the rest are Other", () => {
    const names = ["Housing", "Food & dining", "Transport", "Utilities", "Shopping", "Health", "Business"];
    const transactions = [
      ...names.map((name, index) => spend(800 - index * 100, name, "2026-01-10")),
      spend(5, "Pets", "2026-02-10"),
      spend(50, "Uncategorized", "2026-02-11"),
      spend(999, "Transfers", "2026-02-12"),
      spend(999, "Housing", "2026-02-12", undefined, true),
      tx(200000, "Income", "2026-02-01"),
    ];
    const palette = spendingPalette(transactions);
    expect(palette).toEqual(names);
    expect(spendingTone(palette, "Housing")).toBe(0);
    expect(spendingTone(palette, "Pets")).toBe("other");
    expect(spendingTone(palette, "Uncategorized")).toBe("uncategorized");

    const february = spendingMix(transactions, palette, { startDate: "2026-02-01", endDate: "2026-02-28" });
    expect(february.totalCents).toBe(5500);
    expect(february.parts.map((part) => part.key)).toEqual([OTHER_KEY, "Uncategorized"]);
    expect(february.parts[0].members).toEqual(["Pets"]);
    expect(february.parts[0].share).toBeCloseTo(5 / 55);

    const all = spendingMix(transactions, palette);
    expect(all.parts.map((part) => part.key)).toEqual([...names, OTHER_KEY, "Uncategorized"]);
    expect(all.parts.reduce((sum, part) => sum + (part.share ?? 0), 0)).toBeCloseTo(1);
  });

  it("uses consecutive months ending at the latest month, stacked in one order", () => {
    const transactions = [spend(10, "Food & dining", "2026-01-05"), spend(40, "Housing", "2026-01-06"), spend(20, "Food & dining", "2026-03-05")];
    const months = spendingByMonth(transactions, spendingPalette(transactions), 3);
    expect(months.map((month) => month.month)).toEqual(["2026-01-01", "2026-02-01", "2026-03-01"]);
    expect(months[0].segments.map((segment) => segment.key)).toEqual(["Housing", "Food & dining"]);
    expect(months[0].totalCents).toBe(5000);
    expect(months[1].segments).toEqual([]);
    expect(months[2].totalCents).toBe(2000);
  });

  it("averages a category from its first month and lists its biggest merchants", () => {
    const transactions = [
      spend(10, "Food & dining", "2026-01-05", "STARBUCKS STORE 1234"),
      spend(30, "Food & dining", "2026-03-06", "Starbucks Store 99"),
      spend(20, "Food & dining", "2026-03-07", "CHIPOTLE 0042"),
      spend(5, "Housing", "2025-06-01"),
    ];
    const trend = categoryTrend(transactions, "Food & dining", 12);
    expect(trend.months).toHaveLength(12);
    expect(trend.months[0].month).toBe("2025-04-01");
    expect(trend.latest).toEqual({ month: "2026-03-01", amountCents: 5000 });
    expect(trend.averageCents).toBe(2000);
    expect(topMerchants(transactions, "Food & dining")).toEqual([{ name: "Starbucks Store", amountCents: 4000, count: 2 }, { name: "Chipotle", amountCents: 2000, count: 1 }]);
  });

  it("is empty without transactions", () => {
    expect(spendingPalette([])).toEqual([]);
    expect(spendingMix([], [])).toEqual({ totalCents: 0, parts: [] });
    expect(spendingByMonth([], [])).toEqual([]);
    expect(categoryTrend([], "Housing").averageCents).toBeNull();
  });
});
