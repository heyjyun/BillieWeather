// The website's commands, parsed by the real shared engine, pinned as golden plans. The Rails tests
// (test/integration/finance_smart_command_test.rb) send these exact plans to the trusted executor,
// so the browser's parser and the server's validator are tested against each other.
// Regenerate after an intended parser change:  UPDATE_WEB_PLANS=1 npx vitest run ../../packages/billie-commands/test/webPlans.test.ts

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { NaturalLanguageEngine, type ActionPlan } from "@nlae/core";
import { categoryEntities, WEB_PRODUCT, webRegistry } from "@billie/commands";

const GOLDEN = fileURLToPath(new URL("../../../test/fixtures/files/smart_command/web_plans.json", import.meta.url));

/** Phrase → what it must mean. Phase 1 reads first, then the controlled writes. */
export const WEB_CASES: Array<{ key: string; input: string; action: string; status?: ActionPlan["status"] }> = [
  { key: "expenses_this_month", input: "Show my expenses this month.", action: "finance.spending" },
  { key: "find_uber", input: "Find my Uber transactions.", action: "transactions.find" },
  { key: "spent_last_week", input: "How much did I spend last week?", action: "finance.spending" },
  { key: "open_transactions", input: "Open my transactions.", action: "app.navigate" },
  { key: "zh_last_month_expenses", input: "上个月的支出", action: "finance.spending" },
  { key: "zh_show_last_month_expenses", input: "显示上个月的支出。", action: "finance.spending", status: "needs_clarification" },
  { key: "income_this_year", input: "how much did I earn this year", action: "finance.income" },
  { key: "food_last_month", input: "how much did I spend on food last month", action: "finance.spending" },
  { key: "find_coffee_by_category", input: "show starbucks transactions last month", action: "transactions.find" },
  { key: "find_over_amount", input: "find payments over $100", action: "transactions.find" },
  { key: "balances", input: "show my account balances", action: "finance.balance" },
  { key: "zh_balance", input: "账户余额", action: "finance.balance" },
  { key: "list_categories", input: "list categories", action: "categories.list" },
  { key: "zh_list_categories", input: "有哪些类别", action: "categories.list" },
  { key: "open_forecast", input: "go to forecast", action: "app.navigate" },
  { key: "open_statements", input: "open statements", action: "app.navigate" },
  { key: "zh_open_tax", input: "打开税务", action: "app.navigate" },
  { key: "categorize_uber", input: "move uber to transport", action: "transactions.categorize" },
  { key: "exclude_venmo", input: "exclude venmo", action: "transactions.exclude" },
  { key: "include_venmo", input: "include venmo again", action: "transactions.include" },
  { key: "create_category", input: "create category \"Pet care\"", action: "categories.create" },
  { key: "rename_category", input: "rename category Pets to \"Animals\"", action: "categories.rename" },
  { key: "zh_categorize", input: "把星巴克改成餐饮", action: "transactions.categorize" },
];

export const TODAY = "2026-11-11";
export const CUSTOM = ["Pets"];

export function webEngine(custom: readonly string[] = CUSTOM) {
  return new NaturalLanguageEngine(webRegistry(), {
    list: (kind) => (kind === "category" ? categoryEntities(custom, (n) => n, () => []) : kind === "customCategory" ? custom.map((name) => ({ id: name, label: name })) : []),
  });
}

/** Deterministic copy of a plan: fixed id and time, placeholder tenant (the server sets its own). */
const normalize = (plan: ActionPlan, index: number): ActionPlan => ({ ...plan, planId: `golden-plan-${String(index).padStart(3, "0")}`, createdAt: "2026-11-11T12:00:00.000Z", scope: { ...plan.scope, tenant: "TENANT" } });

async function goldenPlans() {
  const engine = webEngine();
  const plans: Record<string, ActionPlan> = {};
  let index = 0;
  for (const c of WEB_CASES) plans[c.key] = normalize(await engine.interpret(c.input, { product: WEB_PRODUCT, tenant: "TENANT", today: TODAY, defaultCurrency: "USD" }), index++);
  return `${JSON.stringify(plans, null, 2)}\n`;
}

describe("website command plans", () => {
  it("parses every required phrase to the expected action", async () => {
    const engine = webEngine();
    for (const c of WEB_CASES) {
      const plan = await engine.interpret(c.input, { product: WEB_PRODUCT, tenant: "t", today: TODAY, defaultCurrency: "USD" });
      expect({ input: c.input, action: plan.intent?.actionId, status: plan.status }).toEqual({ input: c.input, action: c.action, status: c.status ?? "ready" });
    }
  });

  it("keeps the golden plans the Rails tests use up to date", async () => {
    const fresh = await goldenPlans();
    if (process.env.UPDATE_WEB_PLANS) writeFileSync(GOLDEN, fresh);
    expect(readFileSync(GOLDEN, "utf8")).toBe(fresh);
  });
});
