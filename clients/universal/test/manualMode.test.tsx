// @vitest-environment jsdom
// Manual Mode (progressive disclosure) through the real app shell, with synthetic data only:
// the first screen is the simple interface; Manual reveals the manual workspace; switching back hides
// it without changing records; unfinished input survives a switch; Chinese labels are present.
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import initSqlJs from "sql.js";
import { migrate, showAllModulesInSidebar, openInShell } from "./helpers";
import { sqljsDriver } from "../src/services/sqljsDriver";

const files = new Map<string, ReturnType<typeof sqljsDriver>>();
vi.mock("../src/services/platform", async () => {
  const SQL = await initSqlJs();
  return {
    isTauri: () => false,
    openDatabase: async (file = "billieweather.db") => {
      if (!files.has(file)) {
        const db = new SQL.Database();
        migrate(db);
        db.run("INSERT INTO settings (key, value) VALUES ('owner_account_id', 'id:12345678-1234-4123-8123-123456789abd')");
        db.run("INSERT INTO settings (key, value) VALUES ('database_name', 'Mode book')");
        files.set(file, sqljsDriver(db));
      }
      return { driver: files.get(file)!, persistent: true };
    },
    deviceName: async () => "Mac",
    deviceIdentity: async () => null,
    saveFile: async () => true,
    listSnapshots: async () => [],
  };
});

const { default: App } = await import("../src/App");

function mockAccount(locale = "en") {
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => String(input).endsWith("/account")
    ? new Response(JSON.stringify({ account: { email: "mode@example.com", nickname: null, locale, time_zone: null, usage_region: "US", registered_at: null, badges: [], owner_id: "12345678-1234-4123-8123-123456789abd" } }), { status: 200 })
    : new Response(JSON.stringify({ currency: null, version: "0", statement_count: 0, transaction_count: 0, statements: [], transactions: [], next_after_id: null, rules: [], categories: [] }), { status: 200 }));
}

beforeEach(() => { showAllModulesInSidebar(); localStorage.clear(); sessionStorage.clear(); files.clear(); sessionStorage.setItem("billie.token", "tok"); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const navigation = () => within(screen.getByRole("navigation"));
const nav = (name: string) => openInShell(name);
const badge = () => document.getElementById("manual-mode-badge");
const click = async (element: HTMLElement) => act(async () => { fireEvent.click(element); });
const type = (label: string | RegExp, value: string, root: HTMLElement) => fireEvent.change(within(root).getByLabelText(label), { target: { value } });
const db = () => files.get("billieweather.db")!;
const counts = async () => (await db().select<{ entries: number; accounts: number; audits: number }>(
  "SELECT (SELECT COUNT(*) FROM transactions) AS entries, (SELECT COUNT(*) FROM accounts) AS accounts, (SELECT COUNT(*) FROM audit_events) AS audits"))[0];

it("uses the same destinations and records in both accounting workflows", async () => {
  mockAccount();
  render(<App />);
  await screen.findByRole("navigation");

  // 1–2. The first screen is the simple interface: a Manual button, no manual tools in the navigation.
  const manualButton = screen.getByRole("button", { name: "Manual Accounting" });
  expect(manualButton.getAttribute("aria-pressed")).toBe("false");
  expect(screen.getByRole("button", { name: "AI Automatic" }).getAttribute("aria-pressed")).toBe("true");
  // Since the Feature Library (Phase 1a) the sidebar follows the person's modules (all on in this test),
  // not the mode; the mode decides the tools on each page, and its marker is the "Manual Mode" badge.
  expect(badge()).toBeNull();
  expect(navigation().getByRole("button", { name: "Accounts & Assets" })).toBeTruthy();
  expect(navigation().queryByRole("button", { name: "Manual home" })).toBeNull();
  await nav("All Transactions");
  await screen.findByRole("heading", { level: 1 });
  expect(screen.queryByRole("button", { name: "New entry" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Trash" })).toBeNull();

  await click(screen.getByRole("button", { name: "Manual bookkeeping" }));
  expect(screen.getByRole("button", { name: "New entry" })).toBeTruthy();
  expect(manualButton.getAttribute("aria-pressed")).toBe("false");
  await click(screen.getByRole("button", { name: "Manual bookkeeping" }));

  // Switching mode stays on the current page. Opening the manual workspace is a separate action.
  await click(manualButton);
  expect(screen.getByRole("heading", { name: "Transactions", level: 1 })).toBeTruthy();
  await nav("Manual home");
  await screen.findByRole("heading", { name: "Manual bookkeeping" });
  expect(screen.getByRole("button", { name: "Manual Accounting" }).getAttribute("aria-pressed")).toBe("true");
  expect(badge()).toBeTruthy();
  for (const shown of ["Transactions", "AI Insight", "Accounts & Assets", "Categories", "Budgets", "Recurring Transactions & Bills", "Reports", "Settings"]) expect(navigation().getByRole("button", { name: shown })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Manual bookkeeping" }).getAttribute("aria-current")).toBe("page"); // Transactions › Add & Sync › Manual bookkeeping

  // 4. Create an account and an expense through the workspace.
  await nav("Accounts & Assets");
  await screen.findByRole("heading", { name: "Accounts" });
  fireEvent.change(screen.getByLabelText(/^Book currency/), { target: { value: "USD" } });
  await click(screen.getByRole("button", { name: "Add account" }));
  let form = screen.getByRole("form", { name: "New account" });
  type("Name", "ZXQ Wallet", form);
  fireEvent.change(within(form).getByLabelText("Type"), { target: { value: "cash" } });
  type(/^Opening balance/, "100", form);
  await click(within(form).getByRole("button", { name: "Save" }));
  await screen.findByText("ZXQ Wallet");

  await nav("Manual home");
  await click(await screen.findByRole("button", { name: "Expense" }));
  form = await screen.findByRole("form", { name: "New entry" });
  type("Amount", "12.50", form);
  type(/Merchant/, "ZXQ Cafe", form);
  await click(within(form).getByRole("button", { name: "Save" }));
  await screen.findByText("ZXQ Cafe");
  expect(screen.getAllByRole("button", { name: "Edit" }).length).toBeGreaterThan(0);

  // 5. Back to Default Mode on the same page: the entry is there, the manual controls are not.
  const before = await counts();
  await click(screen.getByRole("button", { name: "AI Automatic" }));
  await waitFor(() => expect(badge()).toBeNull());
  expect(screen.getByText("ZXQ Cafe")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Edit" })).toBeNull();
  expect(screen.queryByRole("button", { name: "New entry" })).toBeNull();
  expect(await counts()).toEqual(before);

  // 6. Both modes report the same balance.
  await click(screen.getByRole("button", { name: "Manual Accounting" }));
  await nav("Accounts & Assets");
  await screen.findByText("ZXQ Wallet");
  expect(screen.getAllByText("$87.50").length).toBeGreaterThan(0);
  expect(await counts()).toEqual(before);

  await click(screen.getByRole("button", { name: "AI Automatic" }));
  expect(screen.getByRole("heading", { name: "Accounts" })).toBeTruthy();
  expect(badge()).toBeNull();
});

it("keeps unfinished input when switching modes, and can discard it", async () => {
  mockAccount();
  render(<App />);
  await screen.findByRole("navigation");
  await click(screen.getByRole("button", { name: "Manual Accounting" }));
  await nav("Accounts & Assets");
  await screen.findByRole("heading", { name: "Accounts" });
  fireEvent.change(screen.getByLabelText(/^Book currency/), { target: { value: "USD" } });
  await click(screen.getByRole("button", { name: "Add account" }));
  let form = screen.getByRole("form", { name: "New account" });
  type("Name", "ZXQ Half-typed", form);
  const before = await counts();

  await click(screen.getByRole("button", { name: "AI Automatic" }));
  await nav("Dashboard");
  await waitFor(() => expect(screen.queryByRole("form", { name: "New account" })).toBeNull());
  expect(await counts()).toEqual(before); // nothing was saved by switching

  await click(screen.getByRole("button", { name: "Manual Accounting" }));
  await nav("Accounts & Assets");
  form = await screen.findByRole("form", { name: "New account" });
  expect((within(form).getByLabelText("Name") as HTMLInputElement).value).toBe("ZXQ Half-typed");
  await click(screen.getByRole("button", { name: "Discard draft" }));
  form = screen.getByRole("form", { name: "New account" });
  expect((within(form).getByLabelText("Name") as HTMLInputElement).value).toBe("");
});

it.each([["zh-CN", "手动记账", "AI 自动"], ["zh-TW", "手動記帳", "AI 自動"]])("labels the switch and workspace in %s", async (locale, manual, plain) => {
  localStorage.setItem("billie.locale", locale);
  mockAccount(locale);
  render(<App />);
  await screen.findByRole("navigation");
  expect(screen.getByRole("button", { name: plain }).getAttribute("aria-pressed")).toBe("true");
  await click(screen.getByRole("button", { name: manual }));
  const { MESSAGES } = await import("../src/i18n");
  const copy = MESSAGES[locale as "zh-CN" | "zh-TW"].modules.sections;
  await click(screen.getByRole("button", { name: copy.addSync }));
  await click(within(document.querySelector<HTMLElement>("#transactions-tabs .bw-subtabs")!).getByRole("button", { name: copy.manual }));
  await screen.findByRole("heading", { name: manual });
});
