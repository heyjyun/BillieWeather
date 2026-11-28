// @vitest-environment jsdom
// A module that is not in the sidebar still works: openInShell reaches it through Settings › Feature
// Library, the way a person would, and a page rendered without the app shell sees the catalog
// defaults (as a new person does): a minimal sidebar, every available module usable.
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import initSqlJs from "sql.js";
import { showAllModulesInSidebar, migrate, openInShell } from "./helpers";
import { sqljsDriver } from "../src/services/sqljsDriver";
import { I18nProvider } from "../src/i18n";
import { useModules } from "../src/hooks/useModules";

vi.mock("../src/services/platform", async () => {
  const SQL = await initSqlJs();
  return {
    isTauri: () => false,
    openDatabase: async () => {
      const db = new SQL.Database();
      migrate(db);
      db.run("INSERT INTO settings (key, value) VALUES ('owner_account_id', 'id:12345678-1234-4123-8123-1234567890ab')");
      db.run("INSERT INTO settings (key, value) VALUES ('database_name', 'Guard book')");
      return { driver: sqljsDriver(db), persistent: true };
    },
    deviceName: async () => "Mac",
    deviceIdentity: async () => null,
    saveFile: async () => true,
    listSnapshots: async () => [],
  };
});

const { default: App } = await import("../src/App");

beforeEach(() => {
  localStorage.clear(); sessionStorage.clear();
  sessionStorage.setItem("billie.token", "tok"); localStorage.setItem("billie.locale", "en");
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => String(input).endsWith("/account")
    ? new Response(JSON.stringify({ account: { email: "guards@example.com", nickname: "Guard", locale: "en", time_zone: null, usage_region: "US", registered_at: null, badges: [], owner_id: "12345678-1234-4123-8123-1234567890ab" } }), { status: 200 })
    : new Response(JSON.stringify({ currency: null, version: "0", statement_count: 0, transaction_count: 0, statements: [], transactions: [], next_after_id: null, rules: [], categories: [] }), { status: 200 }));
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

it("openInShell opens a module that is not in the sidebar through the Feature Library", async () => {
  render(<App />);
  await screen.findByRole("navigation");
  await openInShell("Categories");
  expect(await screen.findByRole("heading", { name: "Categories", level: 1 })).toBeTruthy();
  await openInShell("Reports");
  expect(await screen.findByRole("heading", { name: "Reports", level: 1 })).toBeTruthy();
  // Nothing in the sidebar is highlighted for a hidden module, so the page says where it is, and the
  // sidebar is left as it was.
  const context = document.getElementById("page-context")!;
  expect(context.dataset.module).toBe("reports");
  expect(context.textContent).toContain("Not in your sidebar, still fully usable");
  expect(document.querySelector('#module-nav [data-module="reports"]')).toBeNull();
  fireEvent.click(within(context).getByRole("button", { name: "Settings" }));
  expect(document.getElementById("page-context")).toBeNull();
  // A hidden Transactions page also remains reachable.
  await openInShell("All Transactions");
  expect(document.getElementById("module-unavailable")).toBeNull();
  expect(document.querySelector('#module-nav [data-module="transactions"]')).toBeNull();
  expect(screen.getByRole("heading", { name: "Transactions", level: 1 })).toBeTruthy();
});

it("with every module in the sidebar, the same page opens from the sidebar", async () => {
  showAllModulesInSidebar();
  render(<App />);
  await openInShell("Categories");
  expect(await screen.findByRole("heading", { name: "Categories", level: 1 })).toBeTruthy();
  expect(document.getElementById("page-context")).toBeNull();
});

it("revisits sidebar destinations and uses desktop Back and Forward without writing to the ledger", async () => {
  showAllModulesInSidebar();
  render(<App />);
  const navigation = within(await screen.findByRole("navigation"));
  const pages = [
    ["Transactions", "Transactions"], ["AI Insight", "AI Insight"],
    ["Financial Overview", "Financial Overview"], ["Categories", "Categories"],
    ["Accounts & Assets", "Accounts"], ["Settings", "Settings & privacy"],
  ] as const;
  for (const [label, heading] of pages) {
    const button = navigation.getByRole("button", { name: label });
    expect((button as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(button);
    expect(await screen.findByRole("heading", { name: heading, level: 1 })).toBeTruthy();
  }

  fireEvent.keyDown(window, { key: "[", metaKey: true });
  expect(await screen.findByRole("heading", { name: "Accounts", level: 1 })).toBeTruthy();
  fireEvent.keyDown(window, { key: "ArrowRight", altKey: true });
  expect(await screen.findByRole("heading", { name: "Settings & privacy", level: 1 })).toBeTruthy();
  fireEvent.click(navigation.getByRole("button", { name: "Transactions" }));
  expect(await screen.findByRole("heading", { name: "Transactions", level: 1 })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Nothing to undo" }).getAttribute("aria-disabled")).toBe("true");
});

it("outside the app shell, pages see the catalog defaults: the two default entries, every built module usable", () => {
  function Probe() {
    const { usable, inSidebar, sidebarList } = useModules();
    return <p data-testid="probe">{sidebarList.map((module) => module.id).join(",")}|{String(inSidebar("budgets"))}|{String(usable("budgets"))}|{String(usable("ledgers"))}</p>;
  }
  render(<I18nProvider initial="en"><Probe /></I18nProvider>);
  expect(screen.getByTestId("probe").textContent).toBe("overview,ai_assistant|false|true|false");
});
