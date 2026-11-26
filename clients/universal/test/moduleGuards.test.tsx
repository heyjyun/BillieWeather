// @vitest-environment jsdom
// A module that is turned off is not a missing feature. Tests must be able to tell the two apart:
// openInShell says so explicitly, and a page rendered without the app shell sees the catalog
// defaults (as a new person does), not "everything on".
import { cleanup, render, screen } from "@testing-library/react";
import initSqlJs from "sql.js";
import { enableAllModulesByDefault, migrate, ModuleDisabledInTest, openInShell } from "./helpers";
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

it("openInShell reports a turned-off module instead of a missing button", async () => {
  render(<App />);
  await screen.findByRole("navigation");
  const attempt = openInShell("Categories");
  await expect(attempt).rejects.toBeInstanceOf(ModuleDisabledInTest);
  await expect(openInShell("Reports")).rejects.toThrow(/"reports" module, which is turned off for this test account/);
  // Pages of default modules still open.
  await openInShell("All Transactions");
});

it("with the optional modules turned on, the same page opens", async () => {
  enableAllModulesByDefault();
  render(<App />);
  await openInShell("Categories");
  expect(await screen.findByRole("heading", { name: "Categories", level: 1 })).toBeTruthy();
});

it("outside the app shell, pages see the catalog defaults, not every module", () => {
  function Probe() {
    const { enabled, enabledList } = useModules();
    return <p data-testid="probe">{enabledList.map((module) => module.id).join(",")}|{String(enabled("categories"))}|{String(enabled("ledgers"))}</p>;
  }
  render(<I18nProvider initial="en"><Probe /></I18nProvider>);
  expect(screen.getByTestId("probe").textContent).toBe("transactions,ai_assistant|false|false");
});
