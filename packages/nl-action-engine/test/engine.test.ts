import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  ActionExecutor, ActionRegistry, DialogueSession, NaturalLanguageEngine, PROTOCOL_VERSION, RegistryError, chooseOption, detectLanguage, editDistance, findMoney,
  normalize, originalSlice, type ActionPlan, type ExecutionRequest, type IntentFallback,
} from "../src";
import { aliceExec, aliceParse, toyAuthorizer, toyData, toyEntities, toyHandlers, toyRegistry, TOY_ACTIONS } from "./toyApp";

function setup() {
  const data = toyData();
  const calls: string[] = [];
  const registry = toyRegistry();
  const entities = toyEntities(data);
  let n = 0;
  const engine = new NaturalLanguageEngine(registry, entities, { idFactory: () => `plan_test_${String(++n).padStart(4, "0")}` });
  const executor = new ActionExecutor({ registry, entities, authorizer: toyAuthorizer, handlers: toyHandlers(data, calls), tokenFactory: () => `undo_${++n}` });
  const session = new DialogueSession(engine);
  return { data, calls, registry, engine, executor, session };
}

const args = (plan: ActionPlan) => Object.fromEntries(Object.entries(plan.arguments).map(([k, v]) => [k, v.value]));
const confirm = (plan: ActionPlan, typed?: string): ExecutionRequest => ({ protocol: PROTOCOL_VERSION, plan, confirmation: { confirmed: true, typed } });

describe("normalization and language", () => {
  it("folds width, case and Traditional script for matching but keeps the original text", () => {
    const source = normalize("ＲＥＮＡＭＥ 專案「Café Ｒuns」");
    expect(source.text).toBe("rename 专案\"café runs\"");
    const start = source.text.indexOf("café");
    expect(originalSlice(source, start, start + "café runs".length)).toBe("Café Ｒuns");
  });

  it("detects English, Simplified, Traditional and mixed input", () => {
    expect(detectLanguage("show my tasks").language).toBe("en");
    expect(detectLanguage("显示任务").language).toBe("zh-Hans");
    expect(detectLanguage("顯示這個任務").language).toBe("zh-Hant");
    expect(detectLanguage("把 Work 项目删掉").language).toBe("mixed");
  });

  it("measures edits with transpositions", () => {
    expect(editDistance("taks", "task")).toBe(1);
    expect(editDistance("rename", "renmae")).toBe(1);
    expect(editDistance("kitten", "sitting")).toBe(3);
  });
});

describe("registry", () => {
  it("rejects unsafe or incomplete definitions", () => {
    const base = TOY_ACTIONS[0];
    expect(() => new ActionRegistry("toy", "1", [{ ...base, id: "create" }])).toThrow(RegistryError);
    expect(() => new ActionRegistry("toy", "1", [{ ...base, expressions: ["ok"] }])).toThrow(/too short/);
    expect(() => new ActionRegistry("toy", "1", [{ ...base, params: [{ name: "p", type: "entity" }] }])).toThrow(/entityKind/);
    expect(() => new ActionRegistry("toy", "1", [base, base])).toThrow(/already registered/);
  });

  it("publishes a JSON manifest that another runtime can load", () => {
    const manifest = JSON.parse(JSON.stringify(toyRegistry().manifest()));
    expect(manifest.protocol).toBe(PROTOCOL_VERSION);
    expect(ActionRegistry.fromManifest(manifest).all().map((a) => a.id)).toEqual(TOY_ACTIONS.map((a) => a.id));
  });

  it("refuses an executor without a handler for every action", () => {
    const { registry } = setup();
    const data = toyData();
    const handlers = toyHandlers(data);
    delete handlers["ui.theme"];
    expect(() => new ActionExecutor({ registry, entities: toyEntities(data), authorizer: toyAuthorizer, handlers })).toThrow(/no handler/);
  });
});

describe("intent and parameters", () => {
  it.each([
    ["add task \"Call the bank\" to Home", "tasks.create", { title: "Call the bank", project: "p1" }],
    ["新建任务 买牛奶 到 家务", "tasks.create", { title: "买牛奶", project: "p3" }],
    ["新建任務 買牛奶 到 家務", "tasks.create", { title: "買牛奶", project: "p3" }],
    ["show tasks in work", "tasks.list", { project: "p2" }],
    ["rename project Work to Office", "projects.rename", { project: "p2", name: "Office" }],
    ["把 Work 项目改名为 Office 2027", "projects.rename", { project: "p2", name: "Office 2027" }],
    ["删除项目 家务", "projects.delete", { project: "p3" }],
    ["switch to dark mode", "ui.theme", { theme: "dark" }],
    ["切換到淺色", "ui.theme", { theme: "light" }],
    ["add task pay rent due 2026-12-01", "tasks.create", { title: "pay rent", due: "2026-12-01" }],
  ])("%s", async (input, actionId, expected) => {
    const { engine } = setup();
    const plan = await engine.interpret(input, aliceParse);
    expect(plan.status).toBe("ready");
    expect(plan.intent?.actionId).toBe(actionId);
    expect(args(plan)).toEqual(expected);
  });

  it("tolerates typos and same-sounding Chinese characters, and says so", async () => {
    const { engine } = setup();
    const typo = await engine.interpret("creat taks buy eggs", aliceParse);
    expect([typo.intent?.actionId, args(typo).title]).toEqual(["tasks.create", "buy eggs"]);
    expect(typo.notes.some((n) => n.kind === "typo")).toBe(true);
    const homophone = await engine.interpret("心建任务 交水费", aliceParse); // 心 for 新 (both xin)
    expect([homophone.intent?.actionId, args(homophone).title]).toEqual(["tasks.create", "交水费"]);
    expect(homophone.notes.some((n) => n.kind === "homophone")).toBe(true);
    const entity = await engine.interpret("show tasks in wrok", aliceParse);
    expect(args(entity).project).toBe("p2");
    expect(entity.arguments.project.corrected).toBe(true);
  });

  it("never rewrites the person's own text, even with apparent typos", async () => {
    const { engine } = setup();
    const plan = await engine.interpret("add task \"Cal teh bnak abuot Höme\"", aliceParse);
    expect(args(plan).title).toBe("Cal teh bnak abuot Höme");
  });

  it("reads relative and absolute dates in English and Chinese", async () => {
    const { engine } = setup();
    const when = async (input: string) => (await engine.interpret(input, aliceParse)).arguments.when?.value;
    expect(await when("show tasks last month")).toEqual({ start: "2026-10-01", end: "2026-10-31" });
    expect(await when("显示任务 上个月")).toEqual({ start: "2026-10-01", end: "2026-10-31" });
    expect(await when("显示任务 上个越")).toEqual({ start: "2026-10-01", end: "2026-10-31" }); // 越 for 月
    expect(await when("list tasks past 7 days")).toEqual({ start: "2026-11-05", end: "2026-11-11" });
    expect(await when("列出任务 最近三个月")).toEqual({ start: "2026-08-12", end: "2026-11-11" });
    expect(await when("show tasks from 2026-01-05 to 2026-02-10")).toEqual({ start: "2026-01-05", end: "2026-02-10" });
    expect(await when("显示任务 2025年3月")).toEqual({ start: "2025-03-01", end: "2025-03-31" });
    expect(await when("show tasks in december")).toEqual({ start: "2025-12-01", end: "2025-12-31" }); // most recent December
    expect(await when("show tasks from last week")).toEqual({ start: "2026-11-02", end: "2026-11-08" }); // during, not since
    expect(await when("show tasks since 2026-11-01")).toEqual({ start: "2026-11-01", end: null });
  });

  it("reads amounts only with a currency or a comparison", () => {
    const amounts = (text: string) => findMoney(normalize(text), null).map((m) => m.value);
    expect(amounts("over $50")).toEqual([{ amountMinor: 5000, currency: "USD", comparator: "gt" }]);
    expect(amounts("超过100元")).toEqual([{ amountMinor: 10000, currency: "CNY", comparator: "gt" }]);
    expect(amounts("12.5 dollars")).toEqual([{ amountMinor: 1250, currency: "USD", comparator: "eq" }]);
    expect(amounts("task 12")).toEqual([]);
  });
});

describe("ambiguity, unsupported commands and false positives", () => {
  it("asks which entity when a partial name fits several", async () => {
    const { engine, data } = setup();
    data.projects.push({ id: "p5", name: "Budget 2025", owner: "alice" }, { id: "p6", name: "Budget 2026", owner: "alice" });
    const plan = await engine.interpret("delete project budget", aliceParse);
    expect(plan.status).toBe("needs_clarification");
    expect(plan.clarification?.options.map((o) => o.value).sort()).toEqual(["p5", "p6"]);
    expect(plan.ambiguity.ambiguous).toBe(true);
  });

  it.each([
    "what is the weather like",
    "hello there",
    "今天天气怎么样",
    "I love my dark chocolate",
    "the project manager called",
    "asdf qwer zxcv",
    "",
    "   ",
  ])("does not plan anything for %j", async (input) => {
    const { engine } = setup();
    const plan = await engine.interpret(input, aliceParse);
    expect(plan.status === "unsupported" || plan.intent?.actionId === undefined || plan.risk === "none").toBe(true);
    expect(plan.status === "ready" && plan.risk !== "none").toBe(false);
  });

  it("does not act on negated commands", async () => {
    const { engine } = setup();
    for (const input of ["don't delete project Home", "do not delete project Home", "不要删除项目 家务", "别删除项目家务"]) {
      const plan = await engine.interpret(input, aliceParse);
      expect(plan.status, input).toBe("unsupported");
    }
  });

  it("asks before running a data-changing command that explains little of the input", async () => {
    const { engine } = setup();
    const plan = await engine.interpret("yesterday my colleague said we should rename project Home some day maybe", aliceParse);
    expect(plan.status).not.toBe("ready");
  });

  it("only offers projects the tenant owns", async () => {
    const { engine } = setup();
    const plan = await engine.interpret("delete project Secret", aliceParse);
    expect(plan.status).toBe("needs_clarification");
    expect(plan.clarification?.options.map((o) => o.value)).not.toContain("p9");
  });
});

describe("multi-turn dialogue", () => {
  it("asks for a missing value and accepts a number, an ordinal or a name", async () => {
    for (const answer of ["2", "the second one", "第二个", "work"]) {
      const { session } = setup();
      const first = await session.submit("delete project", aliceParse);
      expect(first.clarification?.kind).toBe("missing");
      const second = await session.submit(answer, aliceParse);
      expect(second.status, answer).toBe("ready");
      expect(args(second).project, answer).toBe("p2");
      expect(second.input).toBe("delete project");
    }
  });

  it("can be cancelled", async () => {
    const { session } = setup();
    await session.submit("rename project", aliceParse);
    const cancelled = await session.submit("算了", aliceParse);
    expect(cancelled.status).toBe("cancelled");
    expect(session.awaiting).toBeNull();
  });

  it("asks for free text and keeps it verbatim", async () => {
    const { session } = setup();
    const first = await session.submit("add task", aliceParse);
    expect(first.clarification?.param).toBe("title");
    const second = await session.submit("  Ｂuy milk & eggs ", aliceParse);
    expect(args(second).title).toBe("Ｂuy milk & eggs");
  });

  it("resolves references to the previous turn", async () => {
    const { session } = setup();
    const list = await session.submit("show tasks in Work", aliceParse);
    session.remember(list);
    const rename = await session.submit("rename it to Job", aliceParse);
    expect(rename.status).toBe("ready");
    expect(args(rename)).toEqual({ project: "p2", name: "Job" });
    expect(rename.notes.some((n) => n.kind === "context")).toBe(true);
  });

  it("asks when a reference cannot be resolved", async () => {
    const { session } = setup();
    const plan = await session.submit("delete it", aliceParse);
    expect(plan.status).toBe("needs_clarification");
  });

  it("continues the previous command with a follow-up value", async () => {
    const { session } = setup();
    const list = await session.submit("show tasks in Home", aliceParse);
    session.remember(list);
    const followUp = await session.submit("and last month", aliceParse);
    expect(followUp.intent?.actionId).toBe("tasks.list");
    expect(args(followUp)).toEqual({ project: "p1", when: { start: "2026-10-01", end: "2026-10-31" } });
    expect(followUp.notes[0].kind).toBe("followUp");
  });

  it("forgets turns beyond its bounds", async () => {
    let now = 0;
    const { engine } = setup();
    const session = new DialogueSession(engine, { ttlMs: 1000, clock: () => now });
    session.remember(await engine.interpret("show tasks in Work", aliceParse));
    now = 5000;
    expect(session.history()).toEqual([]);
    const plan = await session.submit("rename it to Job", aliceParse);
    expect(plan.status).toBe("needs_clarification");
  });

  it("reads option answers", () => {
    const clarification = { kind: "choose" as const, code: "x", message: "", options: [{ value: "a", label: "Home" }, { value: "b", label: "Work" }] };
    expect(chooseOption(clarification, "1")).toBe("a");
    expect(chooseOption(clarification, "last")).toBe("b");
    expect(chooseOption(clarification, "wrok")).toBe("b");
    expect(chooseOption(clarification, "something else entirely")).toBeNull();
  });

  it("applies edits from the structured preview and re-validates them", async () => {
    const { engine } = setup();
    const plan = await engine.interpret("add task buy eggs to Home", aliceParse);
    const edited = await engine.revise(plan, { project: "p2", title: "Buy 12 eggs" }, aliceParse);
    expect(args(edited)).toEqual({ title: "Buy 12 eggs", project: "p2" });
    const invalid = await engine.revise(plan, { project: "p9" }, aliceParse);
    expect(invalid.status).not.toBe("ready");
    const cleared = await engine.revise(plan, { project: null }, aliceParse);
    expect(args(cleared)).toEqual({ title: "buy eggs" });
  });

  it("suggests example commands as the person types", () => {
    const { engine } = setup();
    expect(engine.suggest("add t").map((s) => s.actionId)).toContain("tasks.create");
    expect(engine.suggest("新建").map((s) => s.actionId)).toContain("tasks.create");
    expect(engine.suggest("").length).toBeGreaterThan(0);
  });
});

describe("trusted execution", () => {
  async function ready(input: string) {
    const env = setup();
    const plan = await env.engine.interpret(input, aliceParse);
    expect(plan.status).toBe("ready");
    const preview = await env.executor.preview(plan, aliceExec());
    expect(preview.ok).toBe(true);
    return { ...env, plan: preview.plan };
  }

  it("previews, requires confirmation, then executes once", async () => {
    const { plan, executor, data, calls } = await ready("rename project Work to Office");
    expect(plan.operations).toEqual([{ op: "update", target: { kind: "project", id: "p2", label: "Work" }, before: "Work", after: "Office" }]);
    const unconfirmed = await executor.execute({ protocol: PROTOCOL_VERSION, plan, confirmation: { confirmed: false } }, aliceExec());
    expect(unconfirmed.code).toBe("confirmation_required");
    expect(data.projects.find((p) => p.id === "p2")!.name).toBe("Work");
    const done = await executor.execute(confirm(plan), aliceExec());
    expect(done.status).toBe("succeeded");
    expect(data.projects.find((p) => p.id === "p2")!.name).toBe("Office");
    expect(calls).toEqual(["projects.rename"]);
  });

  it("is idempotent for repeated and concurrent submissions", async () => {
    const { plan, executor, data, calls } = await ready("add task buy eggs");
    const [a, b] = await Promise.all([executor.execute(confirm(plan), aliceExec()), executor.execute(confirm(plan), aliceExec())]);
    const c = await executor.execute(confirm(plan), aliceExec());
    expect([a.status, b.status, c.status]).toEqual(["succeeded", "succeeded", "succeeded"]);
    expect([a.replayed, b.replayed, c.replayed]).toEqual([false, true, true]);
    expect(calls).toEqual(["tasks.create"]);
    expect(data.tasks.length).toBe(1);
  });

  it("requires the typed phrase for destructive actions, computed on the trusted side", async () => {
    const { plan, executor, data } = await ready("删除项目 家务");
    expect(plan.confirmation).toBe("typed");
    expect(plan.confirmationPhrase).toBe("家务");
    expect((await executor.execute(confirm(plan), aliceExec())).code).toBe("typed_confirmation_mismatch");
    expect((await executor.execute(confirm(plan, "Home"), aliceExec())).code).toBe("typed_confirmation_mismatch");
    const tampered = { ...plan, confirmationPhrase: "x", targets: plan.targets.map((t) => ({ ...t, label: "x" })) };
    expect((await executor.execute(confirm(tampered, "x"), aliceExec())).code).toBe("typed_confirmation_mismatch");
    expect(data.projects.some((p) => p.id === "p3")).toBe(true);
    expect((await executor.execute(confirm(plan, " 家务 "), aliceExec())).status).toBe("succeeded");
    expect(data.projects.some((p) => p.id === "p3")).toBe(false);
  });

  it("refuses ambiguous or unfinished plans", async () => {
    const { engine, executor, data } = setup();
    data.projects.push({ id: "p5", name: "Budget 2025", owner: "alice" }, { id: "p6", name: "Budget 2026", owner: "alice" });
    const plan = await engine.interpret("delete project budget", aliceParse);
    const forced = { ...plan, arguments: { project: { value: "p5", source: "input" as const } } };
    expect((await executor.execute(confirm(forced, "Budget 2025"), aliceExec())).code).toBe("not_ready");
    expect(data.projects.some((p) => p.id === "p5")).toBe(true);
  });

  it("refuses an unpreviewed or stale preview", async () => {
    const { plan, executor, data } = await ready("rename project Work to Office");
    expect((await executor.execute(confirm({ ...plan, fingerprint: null }), aliceExec())).code).toBe("stale_preview");
    data.projects.find((p) => p.id === "p2")!.name = "Changed meanwhile";
    expect((await executor.execute(confirm(plan), aliceExec())).code).toBe("stale_preview");
    expect(data.projects.find((p) => p.id === "p2")!.name).toBe("Changed meanwhile");
  });

  it("enforces tenant isolation, authentication and object-level authorization", async () => {
    const { plan, executor, data } = await ready("rename project Work to Office");
    const bob = { ...aliceExec(), tenant: "bob", principal: "bob" };
    expect((await executor.execute(confirm(plan), bob)).code).toBe("scope_mismatch");
    expect((await executor.execute(confirm(plan), { ...aliceExec(), principal: null })).code).toBe("unauthenticated");
    expect((await executor.execute(confirm(plan), { ...aliceExec(), principal: "mallory" })).code).toBe("forbidden");
    // A tampered plan pointing at another tenant's object fails validation: it is not in alice's list.
    const tampered = { ...plan, arguments: { ...plan.arguments, project: { value: "p9", source: "input" as const } } };
    expect((await executor.execute(confirm(tampered), aliceExec())).code).toBe("invalid_arguments");
    const otherProduct = { ...plan, scope: { product: "other-app", tenant: "alice" } };
    expect((await executor.execute(confirm(otherProduct), aliceExec())).code).toBe("scope_mismatch");
    expect(data.projects.find((p) => p.id === "p2")!.name).toBe("Work");
  });

  it("uses the registry's risk, not the plan's", async () => {
    const { plan, executor, data } = await ready("删除项目 家务");
    const tampered = { ...plan, risk: "none" as const, confirmation: "none" as const };
    expect((await executor.execute({ protocol: PROTOCOL_VERSION, plan: tampered, confirmation: { confirmed: false } }, aliceExec())).code).toBe("confirmation_required");
    expect(data.projects.some((p) => p.id === "p3")).toBe(true);
  });

  it("rejects malformed plans and unknown protocols", async () => {
    const { executor } = setup();
    expect((await executor.execute({ protocol: PROTOCOL_VERSION, plan: { nonsense: true } as never, confirmation: { confirmed: true } }, aliceExec())).code).toBe("malformed_plan");
    const { plan } = await ready("add task x");
    expect((await executor.execute({ protocol: "nlae/0" as never, plan, confirmation: { confirmed: true } }, aliceExec())).code).toBe("protocol_mismatch");
  });

  it("does not remember failures, so a retry can succeed", async () => {
    const env = setup();
    const plan = (await env.executor.preview(await env.engine.interpret("rename project Work to FAIL", aliceParse), aliceExec())).plan;
    const failed = await env.executor.execute(confirm(plan), aliceExec());
    expect([failed.status, failed.code]).toEqual(["failed", "handler_error"]);
    expect(env.data.projects.find((p) => p.id === "p2")!.name).toBe("Work");
    const again = await env.executor.execute(confirm(plan), aliceExec());
    expect(again.replayed).toBe(false);
  });

  it("undoes once, only for the same tenant, and only in time", async () => {
    const { plan, executor, data } = await ready("rename project Work to Office");
    const done = await executor.execute(confirm(plan), aliceExec());
    const token = done.undo!.token;
    const bob = { ...aliceExec(), tenant: "bob", principal: "bob" };
    expect((await executor.undo(token, bob)).code).toBe("scope_mismatch");
    expect((await executor.undo(token, aliceExec())).status).toBe("succeeded");
    expect(data.projects.find((p) => p.id === "p2")!.name).toBe("Work");
    expect((await executor.undo(token, aliceExec())).code).toBe("undo_unavailable");

    const second = await ready("add task late");
    const result = await second.executor.execute(confirm(second.plan), aliceExec());
    const later = { ...aliceExec(), now: new Date(aliceExec().now.getTime() + 3_600_000) };
    expect((await second.executor.undo(result.undo!.token, later)).code).toBe("undo_expired");
  });
});

describe("offline, dependency-free and domain-agnostic core", () => {
  const SRC = join(__dirname, "../src");
  const sources = readdirSync(SRC).filter((f) => f.endsWith(".ts")).map((f) => readFileSync(join(SRC, f), "utf8"));

  it("imports nothing outside its own folder and uses no network API", () => {
    for (const source of sources) {
      for (const match of source.matchAll(/from\s+"([^"]+)"/g)) expect(match[1].startsWith("./"), match[1]).toBe(true);
      expect(source).not.toMatch(/\b(fetch|XMLHttpRequest|WebSocket|EventSource|navigator\.sendBeacon)\s*\(/);
    }
  });

  it("contains no business vocabulary from any host application", () => {
    for (const source of sources) expect(source).not.toMatch(/(?<!database )transaction|statement|merchant|categor(y|ies)|billie|finance|task|project/i);
  });

  it("works with the network unavailable", async () => {
    const original = globalThis.fetch;
    globalThis.fetch = (() => { throw new Error("offline"); }) as typeof fetch;
    try {
      const { engine, executor } = setup();
      const plan = (await executor.preview(await engine.interpret("新建任务 离线测试", aliceParse), aliceExec())).plan;
      expect((await executor.execute(confirm(plan), aliceExec())).status).toBe("succeeded");
    } finally {
      globalThis.fetch = original;
    }
  });

  it("treats an optional fallback proposer as a suggestion that must be confirmed", async () => {
    const data = toyData();
    const fallback: IntentFallback = { propose: async () => ({ actionId: "projects.delete", arguments: { project: "p1" } }) };
    const engine = new NaturalLanguageEngine(toyRegistry(), toyEntities(data), { fallback });
    const plan = await engine.interpret("get rid of the house stuff", aliceParse);
    expect(plan.status).toBe("needs_clarification");
    expect(plan.clarification?.kind).toBe("confirmIntent");
    const broken = new NaturalLanguageEngine(toyRegistry(), toyEntities(data), { fallback: { propose: async () => { throw new Error("model offline"); } } });
    expect((await broken.interpret("get rid of the house stuff", aliceParse)).status).toBe("unsupported");
  });
});
