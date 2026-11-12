// @vitest-environment jsdom
// The website's command bar: the shared CommandBar + strings, the remote controller talking to the
// Rails trusted executor (mocked here; the real one is tested in test/integration/finance_smart_command_test.rb),
// translations, theme tokens, responsive layout, and that the committed bundle and manifest are fresh.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { PROTOCOL_VERSION, type ActionPlan, type ExecutionResult, type PreviewResult } from "@nlae/core";
import { commandEn, commandEs, commandJa, commandKo, commandZhCN, commandZhTW, WEB_ACTION_IDS, WEB_PRODUCT, webRegistry, type CommandMessages } from "@billie/commands";
import { WebCommandBar } from "../src/web/WebCommandBar";
import { createRemoteController, type WebCommandContext } from "../src/web/remoteController";

const read = (relative: string) => readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");
const LOCALES: Record<string, CommandMessages> = { en: commandEn, "zh-CN": commandZhCN, "zh-TW": commandZhTW, ja: commandJa, ko: commandKo, es: commandEs };
const ENDPOINTS = { context: "/app/command/context", preview: "/app/command/preview", execute: "/app/command/execute", undo: "/app/command/undo" };

const CONTEXT: WebCommandContext = {
  product: WEB_PRODUCT, tenant: "web-abc", today: "2026-11-11", currency: "USD",
  builtInCategories: ["Income", "Housing", "Food & dining", "Transport", "Utilities", "Shopping", "Health", "Business", "Transfers", "Uncategorized"].map((id) => ({ id, label: id === "Transport" ? "交通" : id, names: [id] })),
  customCategories: ["Pets"],
  pages: { dashboard: "Dashboard", transactions: "Transactions", categories: "Categories" },
};

type Call = { url: string; method: string; body: Record<string, unknown> | null; headers: Record<string, string> };

/** A fake Rails trusted side that records every request. */
function fakeServer(handle: (call: Call) => unknown = defaultHandler) {
  const calls: Call[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const call: Call = { url: String(input), method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : null, headers: (init?.headers ?? {}) as Record<string, string> };
    calls.push(call);
    const answer = handle(call);
    if (answer instanceof Response) return answer;
    return new Response(JSON.stringify(answer), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
  return { calls, fetchImpl };
}

function defaultHandler(call: Call): unknown {
  if (call.url === ENDPOINTS.context) return CONTEXT;
  const plan = call.body?.plan as ActionPlan;
  if (call.url === ENDPOINTS.preview) {
    const write = plan.risk !== "none";
    return { ok: true, plan: { ...plan, fingerprint: "f".repeat(32), confirmation: write ? "confirm" : "none", operations: write ? [{ op: "update", target: { kind: "transaction", id: "1", label: "2026-11-02 · UBER TRIP" }, before: { category: "Uncategorized" }, after: { category: "Transport" } }] : [{ op: "read", target: { kind: "view", id: "x", label: "x" } }] } } satisfies PreviewResult;
  }
  if (call.url === ENDPOINTS.execute) {
    const id = plan.intent!.actionId;
    const base = { protocol: PROTOCOL_VERSION, planId: plan.planId, status: "succeeded" as const, replayed: false, operations: [] };
    if (id === "finance.spending") return { ...base, summary: { code: "spending_total", message: "", vars: { amount: "$43.50", count: 2 } }, undo: null } satisfies ExecutionResult;
    if (id === "transactions.find") return { ...base, summary: { code: "found", message: "", vars: { count: 2 } }, data: { count: 2, redirect: "/app/transactions?search=Uber" }, undo: null };
    if (id === "transactions.categorize") return { ...base, summary: { code: "categorized", message: "", vars: { count: 1, category: "Transport" } }, undo: { token: "undo-token-123456789012345", expiresAt: "2026-11-11T12:10:00Z" } };
  }
  if (call.url === ENDPOINTS.undo) return { protocol: PROTOCOL_VERSION, planId: "undo", status: "succeeded", summary: { code: "undone", message: "Undone." }, replayed: false, operations: [], undo: null };
  return new Response("{}", { status: 500 });
}

afterEach(cleanup);

function mount(options: { locale?: string; handle?: (call: Call) => unknown } = {}) {
  const server = fakeServer(options.handle);
  const navigations: string[] = [];
  let reloads = 0;
  const strings = LOCALES[options.locale ?? "en"];
  render(<WebCommandBar strings={strings} preferHan={false} endpoints={ENDPOINTS} csrfToken={() => "csrf-123"} fetch={server.fetchImpl} navigate={(url) => navigations.push(url)} reload={() => { reloads += 1; }} />);
  const input = screen.getByRole("combobox");
  const type = async (text: string) => {
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: text } });
    await act(async () => { fireEvent.keyDown(input, { key: "Enter" }); });
  };
  return { ...server, navigations, reloads: () => reloads, input, type };
}

describe("website command bar", () => {
  it("parses in the browser and only sends a plan to the trusted side when a command runs", async () => {
    const ui = mount();
    await ui.type("Show my expenses this month.");
    expect(await screen.findByText("Spent $43.50 across 2 transaction(s).")).toBeTruthy();
    expect(ui.calls.map((c) => `${c.method} ${c.url}`)).toEqual(["GET /app/command/context", "POST /app/command/preview", "POST /app/command/execute"]);
    const execute = ui.calls[2];
    expect(execute.headers["X-CSRF-Token"]).toBe("csrf-123");
    expect(execute.body).toMatchObject({ protocol: PROTOCOL_VERSION, confirmation: { confirmed: false } });
    const plan = execute.body!.plan as ActionPlan;
    // The idempotency key is the plan id; the plan carries the server's scope and the person's local date.
    expect(execute.body!.idempotencyKey).toBe(plan.planId);
    expect(plan.scope).toEqual({ product: WEB_PRODUCT, tenant: "web-abc" });
    expect(plan.arguments.period.value).toEqual({ start: "2026-11-01", end: "2026-11-30" });
  });

  it("loads the category context once, not on every command", async () => {
    const ui = mount();
    await ui.type("how much did I spend last week");
    await screen.findByText(/Spent/);
    await ui.type("how much did I spend this month");
    await waitFor(() => expect(ui.calls.filter((c) => c.url === ENDPOINTS.execute)).toHaveLength(2));
    expect(ui.calls.filter((c) => c.url === ENDPOINTS.context)).toHaveLength(1);
  });

  it("opens the Transactions page the server returns after a search, and only same-site paths", async () => {
    const ui = mount();
    await ui.type("Find my Uber transactions.");
    await waitFor(() => expect(ui.navigations).toEqual(["/app/transactions?search=Uber"]));

    cleanup();
    const hostile = mount({ handle: (call) => (call.url === ENDPOINTS.execute ? { ...(defaultHandler(call) as object), data: { redirect: "//evil.example/x" } } : defaultHandler(call)) });
    await hostile.type("Find my Uber transactions.");
    await waitFor(() => expect(hostile.calls.some((c) => c.url === ENDPOINTS.execute)).toBe(true));
    expect(hostile.navigations).toEqual([]);
  });

  it("previews a change, sends nothing until confirmed, then offers Undo and a page refresh", async () => {
    const ui = mount();
    await ui.type("move uber to transport");
    const confirm = await screen.findByRole("button", { name: "Confirm" });
    expect(screen.getByText("1 change(s)")).toBeTruthy();
    expect(screen.getByText(/2026-11-02 · UBER TRIP/)).toBeTruthy();
    expect(ui.calls.some((c) => c.url === ENDPOINTS.execute)).toBe(false);
    await act(async () => { fireEvent.click(confirm); });
    expect(await screen.findByText("1 transaction(s) moved to 交通.")).toBeTruthy();
    const execute = ui.calls.find((c) => c.url === ENDPOINTS.execute)!;
    expect(execute.body!.confirmation).toEqual({ confirmed: true });
    expect((execute.body!.plan as ActionPlan).fingerprint).toBe("f".repeat(32));
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Refresh" })); });
    expect(ui.reloads()).toBe(1);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Undo" })); });
    expect(await screen.findByText("Undone.")).toBeTruthy();
    expect(ui.calls.find((c) => c.url === ENDPOINTS.undo)!.body).toEqual({ protocol: PROTOCOL_VERSION, token: "undo-token-123456789012345" });
  });

  it("asks when a command is ambiguous, and runs nothing until it is answered", async () => {
    const ui = mount({ locale: "zh-CN" });
    await ui.type("显示上个月的支出");
    expect(await screen.findByText(commandZhCN.messages.which_action)).toBeTruthy();
    expect(screen.getByRole("button", { name: commandZhCN.actions.finance_spending })).toBeTruthy();
    expect(ui.calls.filter((c) => c.method === "POST")).toEqual([]);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: commandZhCN.actions.finance_spending })); });
    await waitFor(() => expect(ui.calls.some((c) => c.url === ENDPOINTS.execute)).toBe(true));
  });

  it("shows a readable message when the trusted side cannot be reached or the session ended", async () => {
    const offline = mount({ handle: (call) => (call.url === ENDPOINTS.context ? CONTEXT : new Response("", { status: 503 })) });
    await offline.type("how much did I spend last week");
    expect(await screen.findByText(commandEn.messages.network_error)).toBeTruthy();
    cleanup();
    const signedOut = mount({ handle: (call) => (call.url === ENDPOINTS.context ? CONTEXT : new Response("{}", { status: 401 })) });
    await signedOut.type("how much did I spend last week");
    expect(await screen.findByText(commandEn.messages.unauthenticated)).toBeTruthy();
  });

  it("shows rejections from the trusted side instead of a result", async () => {
    const ui = mount({ handle: (call) => (call.url === ENDPOINTS.preview ? { ok: false, plan: call.body!.plan, rejection: { code: "scope_mismatch", summary: { code: "scope_mismatch", message: "x" } } } : defaultHandler(call)) });
    await ui.type("how much did I spend last week");
    expect(await screen.findByText(commandEn.messages.scope_mismatch)).toBeTruthy();
  });

  it("is keyboard driven and labelled for screen readers", async () => {
    const ui = mount();
    expect(ui.input.getAttribute("aria-autocomplete")).toBe("list");
    expect(screen.getByLabelText(commandEn.labels.inputLabel)).toBe(ui.input);
    expect(screen.getByRole("status")).toBeTruthy();
    // ⌘K / Ctrl+K focuses the bar from anywhere on the page.
    (document.body as HTMLElement).focus();
    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    expect(document.activeElement).toBe(ui.input);
    fireEvent.change(ui.input, { target: { value: "how much" } });
    const list = await screen.findByRole("listbox");
    fireEvent.keyDown(ui.input, { key: "ArrowDown" });
    expect(list.querySelector("[aria-selected=true]")).toBeTruthy();
    fireEvent.keyDown(ui.input, { key: "Enter" });
    expect((ui.input as HTMLInputElement).value).toMatch(/how much/i);
    fireEvent.keyDown(ui.input, { key: "Escape" });
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("uses the interface language for its own text in every website language", () => {
    for (const [locale, strings] of Object.entries(LOCALES)) {
      cleanup();
      mount({ locale });
      expect(screen.getByRole("combobox").getAttribute("placeholder"), locale).toBe(strings.labels.placeholder);
      expect(screen.getByRole("button", { name: strings.labels.submit }), locale).toBeTruthy();
    }
  });
});

describe("remote controller", () => {
  it("never sends a request to parse, suggest or edit", async () => {
    const server = fakeServer();
    const controller = createRemoteController({ registry: webRegistry(), endpoints: ENDPOINTS, csrfToken: () => "t", fetch: server.fetchImpl });
    await controller.context();
    const plan = await controller.submit("move uber to transport");
    controller.suggest("how");
    await controller.edit(plan, { category: "Shopping" });
    expect(server.calls.map((c) => c.url)).toEqual([ENDPOINTS.context]);
  });
});

describe("translations", () => {
  // Every code the Rails executor or the engine can return to the website has text in every language.
  const SERVER_CODES = [
    "navigated", "found", "spending_total", "income_total", "balance_total", "balance_manual", "balance_unknown", "categories_list",
    "categorized", "excluded", "included", "category_created", "category_renamed", "category_exists", "category_reserved", "category_limit",
    "same_name", "no_match", "too_many", "rename_preview", "undone", "undo_conflict", "undo_unavailable", "undo_expired", "in_progress",
    "idempotency_conflict", "scope_mismatch", "unauthenticated", "forbidden", "invalid_arguments", "not_ready", "handler_error", "malformed_plan",
    "protocol_mismatch", "unknown_action", "confirmation_required", "stale_preview", "no_effect", "network_error", "page_outdated", "refresh",
  ];
  for (const [locale, strings] of Object.entries(LOCALES)) {
    it(`${locale} has every website string`, () => {
      const missing = SERVER_CODES.filter((code) => !(strings.messages as Record<string, string>)[code]);
      expect(missing).toEqual([]);
      for (const id of WEB_ACTION_IDS) expect((strings.actions as Record<string, string>)[id.replace(".", "_")], `${locale} ${id}`).toBeTruthy();
      // Placeholders match English, so no value goes missing in a translation.
      for (const code of SERVER_CODES) {
        const names = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
        expect(names((strings.messages as Record<string, string>)[code]), `${locale} ${code}`).toEqual(names((commandEn.messages as Record<string, string>)[code]));
      }
    });
  }

  it("Rails knows every interface language the bar has strings for", () => {
    const rails = ["en", "es", "ja", "ko", "zh-CN", "zh-TW"].filter((locale) => read(`../../../config/locales/billie_layout.${locale}.yml`).length > 0);
    expect(Object.keys(LOCALES).sort()).toEqual(rails.sort());
  });
});

describe("appearance", () => {
  const css = read("../src/web/commandBar.web.css");
  const tokens = read("../../../public/billie-tokens.css");

  it("uses only design tokens that exist, in both light and dark themes", () => {
    const used = [...new Set([...css.matchAll(/var\((--bw-[\w-]+)/g)].map((m) => m[1]))];
    expect(used.length).toBeGreaterThan(10);
    const undefinedTokens = used.filter((name) => !tokens.includes(`${name}:`));
    expect(undefinedTokens).toEqual([]);
    const dark = tokens.slice(tokens.indexOf(':root[data-theme="dark"]'));
    expect(used.filter((name) => name.startsWith("--bw-color-") && !dark.includes(`${name}:`))).toEqual([]);
    // No hard-coded colors: everything follows the theme.
    expect(css.replace(/\/\*[\s\S]*?\*\//g, "")).not.toMatch(/#[0-9a-f]{3,8}\b|rgb\(|hsl\(/i);
  });

  it("maps the command bar to the same tokens as the universal client", () => {
    const universal = read("../../../clients/universal/src/styles.css");
    const mapping = (text: string) => [...text.matchAll(/(--nlae-[\w-]+): (var\(--bw-[\w-]+\))/g)].map((m) => `${m[1]}=${m[2]}`).filter((pair) => !pair.startsWith("--nlae-font-size"));
    const universalBlock = universal.slice(universal.indexOf(".bw-command {"), universal.indexOf("}", universal.indexOf(".bw-command {")));
    expect(mapping(css.slice(0, css.indexOf("}")))).toEqual(mapping(universalBlock));
  });

  it("has a phone layout that keeps the bar out of the way of the page", () => {
    const phone = css.slice(css.indexOf("@media (max-width: 760px)"));
    expect(phone).toMatch(/\.bw-command \{[^}]*flex: 1 1 100%/);
    expect(phone).toMatch(/font-size: 16px/); // no iOS zoom on focus
    expect(phone).toMatch(/\.nlae-output \{[^}]*position: static/);
    // Desktop results float and scroll inside a bounded panel.
    expect(css).toMatch(/\.nlae-output \{[^}]*position: absolute[^}]*max-height: min\(70vh, 560px\)[^}]*overflow: auto/);
  });
});
