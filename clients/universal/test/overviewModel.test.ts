import { describe, expect, it } from "vitest";
import {
  buckets,
  groupBalance,
  position,
  previous,
  project,
  schedule,
  shift,
  totals,
  type Holding,
} from "../src/overview/model";
import { resolvePeriod } from "@billie/finance-core";
const all = resolvePeriod("all_time", { today: "2026-11-28" });
const holding = (type: string, balance: number | null, overrides: Partial<Holding> = {}): Holding => ({
  type,
  balance,
  liability: false,
  included: true,
  archived: false,
  ...overrides,
});
describe("dashboard financial definitions", () => {
  it("keeps investments and credit out of cash, honors inclusion, and distinguishes missing balances from zero", () => {
    const p = {
      extraCash: 500,
      cashOverride: null,
      holdings: [
        holding("cash", 1000),
        holding("investment", 8000),
        holding("loan", -400, { liability: true }),
        holding("cash", 200, { included: false }),
        holding("cash", 500, { archived: true, included: false }),
      ],
    };
    expect(groupBalance(p, "liquid")).toBe(1500);
    expect(groupBalance({ extraCash: 0, cashOverride: null, holdings: [] }, "liquid")).toBe(0);
    expect(groupBalance({ extraCash: null, cashOverride: 400, holdings: [] }, "liquid")).toBe(400);
    expect(groupBalance(p, "fixed")).toBeNull();
    expect(position(p)).toMatchObject({
      assets: 9500,
      liabilities: 400,
      worth: 9100,
      available: 1700,
      fixed: null,
    });
    expect(position({ ...p, extraCash: null, holdings: [] })).toMatchObject({ worth: null, available: null });
    expect(position({ ...p, extraCash: null, holdings: [holding("cash", 0)] })).toMatchObject({
      worth: 0,
      available: 0,
    });
    expect(position({ ...p, holdings: [holding("cash", null)] })).toMatchObject({ worth: null, available: null });
  });
  it("uses the previous calendar or equal-length period including across leap years", () => {
    expect(previous(resolvePeriod("this_month", { today: "2024-03-03" }))).toMatchObject({
      startDate: "2024-02-01",
      endDate: "2024-02-29",
    });
    expect(previous(resolvePeriod("last_year", { today: "2026-11-28" }))).toMatchObject({
      startDate: "2024-01-01",
      endDate: "2024-12-31",
    });
    expect(
      previous(resolvePeriod("custom", { today: "2026-01-10", startDate: "2026-01-01", endDate: "2026-01-10" })),
    ).toMatchObject({ startDate: "2025-12-22", endDate: "2025-12-31" });
    expect(previous(all)).toBeNull();
  });
  it("keeps observed zero and negative net expenses and aggregates the same totals at each resolution", () => {
    const days = [
      { date: "2026-01-04", income: 0, expenses: -500, counted: true },
      { date: "2026-01-05", income: 1500, expenses: 300, counted: true },
    ];
    expect(totals([], all)).toBeNull();
    expect(totals(days, all)).toMatchObject({ income: 1500, expenses: -200, net: 1700 });
    for (const scale of ["daily", "weekly", "monthly", "yearly"] as const)
      expect(totals(buckets(days, all, scale), all)).toEqual(totals(days, all));
  });
  it("requires an opening balance and sufficient recent economic activity before projecting", () => {
    const today = "2026-11-28";
    const days = [-20, -10, 0].map((n) => ({ date: shift(today, n), income: 0, expenses: 700, counted: true }));
    expect(project(days, null, today)).toEqual([]);
    expect(project(days.slice(1), 0, today)).toEqual([]);
    expect(
      project(
        days.map((d) => ({ ...d, counted: false })),
        0,
        today,
      ),
    ).toEqual([]);
    expect(project(days, 100, today)[30]).toEqual({ date: "2026-12-28", balance: -2900 });
    expect(project(days, 100, today)).toHaveLength(91);
  });
  it("respects recurrence anchors, next unposted occurrences, and schedule end dates", () => {
    expect(schedule("2024-01-31", "2024-02-29", "2024-03-31", "monthly", 1, "2024-02-10")).toEqual([
      "2024-02-29",
      "2024-03-31",
    ]);
  });
});
