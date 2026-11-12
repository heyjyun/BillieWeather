// Measured accuracy of the typed command parser on the labeled corpus (test/commands/corpus.json).
// Prints a report; set NLAE_EVAL_REPORT=path to also write it as JSON. The thresholds below are the
// floor the current parser must keep — they were set from a measured run, not assumed.

import { writeFileSync } from "node:fs";
import { NaturalLanguageEngine, type ActionPlan } from "@nlae/core";
import corpus from "./corpus.json";
import heldout from "./heldout.json";
import { billieRegistry, PRODUCT } from "../../src/commands/actions";
import { createEntities } from "../../src/commands/handlers";

interface Case { input: string; action: string | null; args?: Record<string, unknown>; status?: string; tags: string[] }

const sameValue = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

export async function evaluate(set: { cases: unknown[] } = corpus) {
  const data = { transactions: [], customCategories: ["Pets", "Coffee runs"], currency: "USD" };
  const engine = new NaturalLanguageEngine(billieRegistry(), createEntities({ data: () => data, categoryLabel: (n) => n }));
  const rows: Array<{ input: string; tags: string[]; expected: string | null; got: string | null; status: string; intentOk: boolean; argsOk: boolean; statusOk: boolean; ms: number }> = [];
  for (const item of (set as { cases: Case[] }).cases) {
    const started = performance.now();
    const plan: ActionPlan = await engine.interpret(item.input, { product: PRODUCT, tenant: "eval", today: "2026-11-11", defaultCurrency: null });
    const ms = performance.now() - started;
    const got = plan.status === "unsupported" ? null : plan.intent?.actionId ?? null;
    const expectedStatus = item.action === null ? "not-ready" : item.status ?? "ready";
    const statusOk = item.action === null ? plan.status !== "ready" : plan.status === expectedStatus;
    const intentOk = item.action === null ? plan.status !== "ready" : got === item.action;
    const argsOk = Object.entries(item.args ?? {}).every(([name, value]) => sameValue(plan.arguments[name]?.value, value));
    rows.push({ input: item.input, tags: item.tags, expected: item.action, got, status: plan.status, intentOk, argsOk, statusOk, ms });
  }
  const positives = rows.filter((r) => r.expected !== null && !r.tags.includes("clarify"));
  const clarify = rows.filter((r) => r.tags.includes("clarify"));
  const negatives = rows.filter((r) => r.expected === null);
  const rate = (list: typeof rows, ok: (r: (typeof rows)[number]) => boolean) => (list.length ? list.filter(ok).length / list.length : 1);
  const byTag: Record<string, { n: number; intent: number; full: number }> = {};
  for (const tag of ["en", "zh-Hans", "zh-Hant", "mixed", "typo", "homophone", "paraphrase"]) {
    const list = positives.filter((r) => r.tags.includes(tag));
    byTag[tag] = { n: list.length, intent: rate(list, (r) => r.intentOk), full: rate(list, (r) => r.intentOk && r.argsOk && r.statusOk) };
  }
  const report = {
    cases: rows.length,
    positives: positives.length,
    intentAccuracy: rate(positives, (r) => r.intentOk),
    fullAccuracy: rate(positives, (r) => r.intentOk && r.argsOk && r.statusOk),
    clarificationAccuracy: rate(clarify, (r) => r.intentOk && r.statusOk),
    negatives: negatives.length,
    falsePositiveRate: rate(negatives, (r) => r.status === "ready"),
    /** Negatives that became a ready plan for a data-changing action: the unsafe kind. */
    unsafeFalsePositives: rows.filter((r) => r.expected === null && r.status === "ready" && !["transactions.find", "finance.spending", "finance.income", "app.navigate", "app.theme", "app.language"].includes(r.got ?? "")).length,
    byTag,
    p95ms: rows.map((r) => r.ms).sort((a, b) => a - b)[Math.floor(rows.length * 0.95)],
    failures: rows.filter((r) => !(r.intentOk && r.argsOk && r.statusOk)).map(({ input, expected, got, status, argsOk }) => ({ input, expected, got, status, argsOk })),
  };
  return report;
}

describe("held-out evaluation (not used for tuning)", () => {
  it("reports accuracy and never prepares a data change from a negative example", async () => {
    const report = await evaluate(heldout);
    console.log(JSON.stringify({ heldout: report }, null, 2));
    if (process.env.NLAE_EVAL_REPORT) writeFileSync(`${process.env.NLAE_EVAL_REPORT}.heldout.json`, JSON.stringify(report, null, 2));
    expect(report.unsafeFalsePositives).toBe(0);
  });
});

describe("command corpus evaluation", () => {
  it("meets the measured accuracy floor and never runs a negative example", async () => {
    const report = await evaluate();
    console.log(JSON.stringify(report, null, 2));
    if (process.env.NLAE_EVAL_REPORT) writeFileSync(process.env.NLAE_EVAL_REPORT, JSON.stringify(report, null, 2));
    expect(report.falsePositiveRate).toBe(0);
    expect(report.intentAccuracy).toBeGreaterThanOrEqual(0.95);
    expect(report.fullAccuracy).toBeGreaterThanOrEqual(0.9);
    expect(report.clarificationAccuracy).toBe(1);
  });
});
