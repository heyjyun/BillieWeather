// BillieWeather's real typed-command actions, end to end: parse → trusted preview → confirm →
// execute through FinanceStore on a real (in-memory sql.js) SQLite database → undo.

import { ActionExecutor, DialogueSession, NaturalLanguageEngine, PROTOCOL_VERSION, type ActionPlan, type ExecutionContext } from "@nlae/core";
import type { Transaction } from "@billie/shared-types";
import { fixtureBytes, newStore } from "../helpers";
import { importFile } from "../../src/services/importFile";
import type { FinanceStore, SqlDriver } from "../../src/services/store";
import { billieRegistry, PRODUCT } from "../../src/commands/actions";
import { createAuthorizer, createEntities, createHandlers, type HostDeps, type TransactionFilter } from "../../src/commands/handlers";
import type { Page } from "../../src/App";

const TENANT = "jyun@example.com#db-1";

async function setup(options: { failAfter?: number } = {}) {
  const { db, store } = await newStore();
  await importFile(store, fixtureBytes("basic-amount.csv"), "basic-amount.csv", "USD");
  await store.addCategory("Pets");
  let finance = { transactions: [] as Transaction[], customCategories: [] as string[], currency: "USD" as string | null };
  const refresh = async () => { finance = { transactions: await store.transactions(), customCategories: await store.customCategories(), currency: await store.currency() }; };
  await refresh();
  const navigations: Array<{ page: Page; filter?: TransactionFilter }> = [];
  const preferences: string[] = [];
  // Optionally fail the Nth write, to prove compensation.
  let writes = 0;
  const target: FinanceStore = options.failAfter === undefined ? store : wrapFailing(store, () => ++writes > options.failAfter!);
  const deps: HostDeps = {
    store: target, data: () => finance, refresh, navigate: (page, filter) => navigations.push({ page, filter }),
    setLanguage: (l) => preferences.push(`lang:${l}`), setTheme: (t) => preferences.push(`theme:${t}`), categoryLabel: (n) => n,
  };
  const registry = billieRegistry();
  const entities = createEntities(deps);
  const engine = new NaturalLanguageEngine(registry, entities);
  const executor = new ActionExecutor({ registry, entities, authorizer: createAuthorizer(), handlers: createHandlers(deps) });
  const session = new DialogueSession(engine);
  const parse = { product: PRODUCT, tenant: TENANT, today: "2026-02-15", defaultCurrency: "USD" };
  const exec = (): ExecutionContext => ({ product: PRODUCT, tenant: TENANT, principal: "jyun@example.com", now: new Date("2026-02-15T12:00:00Z") });
  const plan = async (input: string) => {
    const parsed = await session.submit(input, parse);
    expect(parsed.status, `${input}: ${JSON.stringify(parsed.clarification ?? parsed.issues)}`).toBe("ready");
    const preview = await executor.preview(parsed, exec());
    expect(preview.ok, JSON.stringify(preview.rejection)).toBe(true);
    return preview.plan;
  };
  const run = (p: ActionPlan, typed?: string) => executor.execute({ protocol: PROTOCOL_VERSION, plan: p, confirmation: { confirmed: true, typed } }, exec());
  const byDescription = (part: string) => finance.transactions.filter((t) => t.description.includes(part));
  return { db, store, session, executor, plan, run, exec, parse, navigations, preferences, byDescription, data: () => finance, refresh };
}

/** A FinanceStore whose SQL writes start failing after `shouldFail` says so. */
function wrapFailing(store: FinanceStore, shouldFail: () => boolean): FinanceStore {
  const db = (store as unknown as { db: SqlDriver }).db;
  const failing: SqlDriver = {
    select: (sql, params) => db.select(sql, params),
    execute: async (sql, params) => {
      if (/^\s*UPDATE transactions SET category = \$1, tax_review/.test(sql) && shouldFail()) throw new Error("disk full");
      return db.execute(sql, params);
    },
  };
  (store as unknown as { db: SqlDriver }).db = failing;
  return store;
}

describe("BillieWeather typed commands on a real local database", () => {
  it("answers spending questions exactly like the dashboard counts (no transfers, no excluded rows)", async () => {
    const env = await setup();
    const result = await env.run(await env.plan("how much did I spend in January 2026"));
    // Jan: 5.75 + 1650 + 61.20 (the savings transfer is a transfer).
    expect(result.data).toEqual({ totalCents: 171695, count: 3 });
    const food = await env.run(await env.plan("2月餐饮花了多少钱"));
    expect(food.status).toBe("succeeded");
    const income = await env.run(await env.plan("how much did I earn this year"));
    expect(income.data).toEqual({ totalCents: 500000, count: 2 });
  });

  it("finds transactions and opens the list with the same filter", async () => {
    const env = await setup();
    const result = await env.run(await env.plan("show starbucks transactions in january"));
    expect(result.data).toEqual({ count: 1 });
    expect(env.navigations.at(-1)).toMatchObject({ page: "transactions", filter: { query: "starbucks", period: { start: "2026-01-01", end: "2026-01-31" } } });
  });

  it("previews, then recategorizes after confirmation, and undoes exactly", async () => {
    const env = await setup();
    const before = await env.store.transactionFlags(env.byDescription("STARBUCKS").map((t) => t.id));
    const plan = await env.plan("把 Starbucks 改成购物");
    expect(plan.confirmation).toBe("confirm");
    expect(plan.operations).toHaveLength(1);
    expect(env.byDescription("STARBUCKS")[0].category).not.toBe("Shopping");
    const unconfirmed = await env.executor.execute({ protocol: PROTOCOL_VERSION, plan, confirmation: { confirmed: false } }, env.exec());
    expect(unconfirmed.code).toBe("confirmation_required");
    const done = await env.run(plan);
    expect(done.status).toBe("succeeded");
    expect(env.byDescription("STARBUCKS")[0].category).toBe("Shopping");
    expect((await env.executor.undo(done.undo!.token, env.exec())).status).toBe("succeeded");
    expect(await env.store.transactionFlags(before.map((f) => f.id))).toEqual(before);
  });

  it("does not repeat a change when the same plan is submitted twice", async () => {
    const env = await setup();
    const plan = await env.plan("exclude uber eats");
    const [first, second] = await Promise.all([env.run(plan), env.run(plan)]);
    expect([first.replayed, second.replayed].sort()).toEqual([false, true]);
    expect(env.byDescription("UBER")[0].excluded).toBe(true);
    // A new command to include it again is a new plan, so it runs.
    await env.run(await env.plan("include uber eats again"));
    expect(env.byDescription("UBER")[0].excluded).toBe(false);
  });

  it("rolls every row back when a bulk change fails part-way", async () => {
    const env = await setup({ failAfter: 2 });
    const ids = env.data().transactions.map((t) => t.id);
    const before = await env.store.transactionFlags(ids);
    // Every description contains an "e": a 9-row change that fails on the 3rd row.
    const plan = await env.plan("move \"e\" to Pets");
    expect(plan.operations.length).toBeGreaterThan(2);
    const result = await env.run(plan);
    expect([result.status, result.code]).toEqual(["failed", "handler_error"]);
    expect(await env.store.transactionFlags(ids)).toEqual(before);
  });

  it("refuses to run a preview whose data changed meanwhile", async () => {
    const env = await setup();
    const plan = await env.plan("move starbucks to shopping");
    const [starbucks] = env.byDescription("STARBUCKS");
    await env.store.setCategory(starbucks.id, "Health", false); // someone else changed it meanwhile
    await env.refresh();
    expect((await env.run(plan)).code).toBe("stale_preview");
  });

  it("creates, renames and deletes categories with the right confirmations, and undoes the delete", async () => {
    const env = await setup();
    const create = await env.plan("新建类别 宠物医疗");
    expect(create.confirmation).toBe("confirm");
    await env.run(create);
    expect(env.data().customCategories).toContain("宠物医疗");
    await env.run(await env.plan("move starbucks to Pets"));
    await env.run(await env.plan("rename category Pets to Pet care"));
    expect(env.byDescription("STARBUCKS")[0].category).toBe("Pet care");

    const remove = await env.plan("delete category pet care");
    expect([remove.confirmation, remove.confirmationPhrase]).toEqual(["typed", "Pet care"]);
    expect((await env.run(remove)).code).toBe("typed_confirmation_mismatch");
    expect(env.data().customCategories).toContain("Pet care");
    const deleted = await env.run(remove, "pet care");
    expect(deleted.status).toBe("succeeded");
    expect(env.byDescription("STARBUCKS")[0].category).toBe("Uncategorized");
    await env.executor.undo(deleted.undo!.token, env.exec());
    expect(env.data().customCategories).toContain("Pet care");
    expect(env.byDescription("STARBUCKS")[0].category).toBe("Pet care");
  });

  it("refuses an existing category name and an unmatched search, changing nothing", async () => {
    const env = await setup();
    const exists = await env.executor.preview(await env.session.submit("create category Pets", env.parse), env.exec());
    expect(exists.rejection?.code).toBe("no_effect");
    expect(exists.rejection?.summary.code).toBe("category_exists");
    const none = await env.executor.preview(await env.session.submit("exclude nonexistent merchant xyz", env.parse), env.exec());
    expect(none.rejection?.summary.code).toBe("no_match");
  });

  it("keeps plans inside their account and database", async () => {
    const env = await setup();
    const plan = await env.plan("move starbucks to shopping");
    const otherDatabase = { ...env.exec(), tenant: "jyun@example.com#db-2" };
    expect((await env.executor.execute({ protocol: PROTOCOL_VERSION, plan, confirmation: { confirmed: true } }, otherDatabase)).code).toBe("scope_mismatch");
    const otherAccount = { ...env.exec(), principal: "someone@else.com" };
    expect((await env.executor.execute({ protocol: PROTOCOL_VERSION, plan, confirmation: { confirmed: true } }, otherAccount)).code).toBe("forbidden");
    const signedOut = { ...env.exec(), principal: null };
    expect((await env.executor.execute({ protocol: PROTOCOL_VERSION, plan, confirmation: { confirmed: true } }, signedOut)).code).toBe("unauthenticated");
    expect(env.byDescription("STARBUCKS")[0].category).not.toBe("Shopping");
  });

  it("follows up on the previous command", async () => {
    const env = await setup();
    const found = await env.plan("show uber eats");
    await env.run(found);
    env.session.remember(found);
    const followUp = await env.plan("把它们改成购物");
    expect(followUp.arguments.query.value).toBe("uber eats");
    expect(followUp.notes.some((n) => n.kind === "context")).toBe(true);
  });

  it("changes language and appearance without confirmation (preferences, not data)", async () => {
    const env = await setup();
    const language = await env.plan("切换语言 繁体中文");
    expect(language.confirmation).toBe("none");
    await env.executor.execute({ protocol: PROTOCOL_VERSION, plan: language, confirmation: { confirmed: false } }, env.exec());
    await env.executor.execute({ protocol: PROTOCOL_VERSION, plan: await env.plan("switch to dark mode"), confirmation: { confirmed: false } }, env.exec());
    expect(env.preferences).toEqual(["lang:zh-TW", "theme:dark"]);
  });
});
