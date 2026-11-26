// @vitest-environment jsdom
// A module that is not in the sidebar still works: openInShell reaches it through Settings › Feature
// Library, the way a person would, and a page rendered without the app shell sees the catalog
// defaults (as a new person does): a minimal sidebar, every available module usable.
import { cleanup, render, screen } from "@testing-library/react";
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
  // Pages of sidebar modules open directly.
  await openInShell("All Transactions");
  expect(document.getElementById("module-unavailable")).toBeNull();
});

it("with every module in the sidebar, the same page opens from the sidebar", async () => {
  showAllModulesInSidebar();
  render(<App />);
  await openInShell("Categories");
  expect(await screen.findByRole("heading", { name: "Categories", level: 1 })).toBeTruthy();
});

it("outside the app shell, pages see the catalog defaults: a minimal sidebar, every built module usable", () => {
  function Probe() {
    const { usable, inSidebar, sidebarList } = useModules();
    return <p data-testid="probe">{sidebarList.map((module) => module.id).join(",")}|{String(inSidebar("categories"))}|{String(usable("categories"))}|{String(usable("ledgers"))}</p>;
  }
  render(<I18nProvider initial="en"><Probe /></I18nProvider>);
  expect(screen.getByTestId("probe").textContent).toBe("transactions,ai_assistant|false|true|false");
});
