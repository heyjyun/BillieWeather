// @vitest-environment jsdom
// Feature Library and Settings through the real app shell, with synthetic data only: the minimal default
// sidebar, every built module usable without changing anything, showing and hiding modules in the
// sidebar, persistence across a restart, platform status (coming soon / website only), Add & Sync, and
// the guarantee that none of it changes a financial record or Manual Mode.
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import initSqlJs from "sql.js";
import { fixtureBytes, migrate } from "./helpers";
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
        db.run("INSERT INTO settings (key, value) VALUES ('owner_account_id', 'id:12345678-1234-4123-8123-1234567890fe')");
        db.run("INSERT INTO settings (key, value) VALUES ('database_name', 'Library book')");
        const driver = sqljsDriver(db);
        // Synthetic statement through the real import path, so the book has records to protect.
        const [{ FinanceStore }, { importFile }] = await Promise.all([import("../src/services/store"), import("../src/services/importFile")]);
        await importFile(new FinanceStore(driver), fixtureBytes("basic-amount.csv"), "basic-amount.csv", "USD");
        files.set(file, driver);
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

function mockAccount() {
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => String(input).endsWith("/account")
    ? new Response(JSON.stringify({ account: { email: "library@example.com", nickname: null, locale: "en", time_zone: null, usage_region: "US", registered_at: null, badges: [], owner_id: "12345678-1234-4123-8123-1234567890fe" } }), { status: 200 })
    : new Response(JSON.stringify({ currency: null, version: "0", statement_count: 0, transaction_count: 0, statements: [], transactions: [], next_after_id: null, rules: [], categories: [] }), { status: 200 }));
}

beforeEach(() => { localStorage.clear(); sessionStorage.clear(); files.clear(); sessionStorage.setItem("billie.token", "tok"); localStorage.setItem("billie.locale", "en"); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const sidebar = async () => within(await screen.findByRole("navigation"));
const labels = async () => [...(await screen.findByRole("navigation")).querySelectorAll("#module-nav button, .bw-system-nav button")].map((button) => button.textContent?.trim());
const click = async (element: HTMLElement) => act(async () => { fireEvent.click(element); });
const fingerprint = async () => JSON.stringify(await files.get("billieweather.db")!.select("SELECT * FROM transactions ORDER BY id"));

async function openLibrary() {
  await click((await sidebar()).getByRole("button", { name: "Settings" }));
  await click(await screen.findByRole("button", { name: "Open Feature Library" }));
  await screen.findByRole("heading", { name: "Feature Library", level: 1 });
}
const switchFor = (name: string) => screen.getByRole("switch", { name: `Show ${name} in the sidebar` });
const choicesSaved = () => Object.keys(localStorage).filter((key) => key.startsWith("billie.modules.v1:")).map((key) => localStorage.getItem(key));

it("a new person sees the two default entries and Settings, in order; the tabs are Overview, All Transactions, Add & Sync", async () => {
  mockAccount();
  render(<App />);
  await waitFor(async () => expect((await labels()).filter((label) => label !== "Collapse sidebar")).toEqual(["Financial Overview", "AI Insight", "Settings"]));
  expect(screen.getByRole("button", { name: "Overview" }).getAttribute("aria-current")).toBe("page");
  expect(screen.getByRole("button", { name: "All Transactions" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Add & Sync" })).toBeTruthy();
});

it("keeps Settings groups in catalog order while the sidebar moves across groups", async () => {
  mockAccount();
  render(<App />);
  await click((await sidebar()).getByRole("button", { name: "Settings" }));
  await click(await screen.findByRole("switch", { name: "Show Transactions in the sidebar" }));
  const navIds = () => [...document.querySelectorAll<HTMLElement>("#module-nav [data-module]")].map((node) => node.dataset.module);
  expect(navIds()).toEqual(["overview", "ai_assistant", "transactions"]);
  await click(screen.getByRole("button", { name: "Move Transactions up" }));
  expect(navIds()).toEqual(["overview", "transactions", "ai_assistant"]);
  const groups = [...document.querySelectorAll<HTMLElement>("#settings-feature-library [data-module-group]")];
  expect(groups.map((group) => group.dataset.moduleGroup)).toEqual(["intelligence", "financial", "analytics", "add_sync", "system"]);
  expect(groups.map((group) => [...group.querySelectorAll<HTMLElement>("[data-module]")].map((row) => row.dataset.module)))
    .toEqual([["overview", "ai_assistant"], ["transactions", "accounts", "fixed_assets", "categories", "budgets", "recurring"],
      ["reports", "forecast"], ["import", "receipts"], ["data_management"]]);
});

it("every built module opens for a new person from Settings, without changing the sidebar or any record", async () => {
  mockAccount();
  render(<App />);
  await screen.findByRole("navigation");
  const before = await fingerprint();
  const pages: Array<[string, string]> = [["Accounts & Assets", "Accounts"], ["Categories", "Categories"], ["Reports", "Reports"]];
  for (const [name, heading] of pages) {
    await click((await sidebar()).getByRole("button", { name: "Settings" }));
    await screen.findByRole("heading", { name: "Settings & privacy", level: 1 });
    const manager = screen.getByRole("region", { name: "Feature Management" });
    await click(within(manager).getByRole("button", { name: `Open ${name}` }));
    expect(await screen.findByRole("heading", { name: heading, level: 1 })).toBeTruthy();
    expect(document.getElementById("module-unavailable")).toBeNull();
  }
  expect((await labels()).filter((label) => label !== "Collapse sidebar" && label !== "Settings")).toEqual(["Financial Overview", "AI Insight"]);
  expect(choicesSaved().every((value) => !value || !value.includes("sidebarVisible\":true"))).toBe(true);
  expect(await fingerprint()).toBe(before);
});

it("shows and hides a module in the sidebar, keeps the choice after a restart, and never touches records", async () => {
  mockAccount();
  const view = render(<App />);
  await screen.findByRole("navigation");
  const before = await fingerprint();
  await openLibrary();
  const reports = switchFor("Reports");
  expect(reports.getAttribute("aria-checked")).toBe("false");
  await click(reports);
  expect(switchFor("Reports").getAttribute("aria-checked")).toBe("true");
  expect((await sidebar()).getByRole("button", { name: "Reports" })).toBeTruthy(); // the sidebar updates at once
  expect(await fingerprint()).toBe(before);

  // Restart: the choice is read back.
  view.unmount();
  cleanup();
  render(<App />);
  await waitFor(async () => expect((await sidebar()).getByRole("button", { name: "Reports" })).toBeTruthy());

  // Hidden again: not in the sidebar, still opens from the library; data and Default/Manual unchanged.
  await openLibrary();
  await click(switchFor("Reports"));
  await waitFor(async () => expect((await sidebar()).queryByRole("button", { name: "Reports" })).toBeNull());
  expect(screen.getByRole("button", { name: "AI Automatic" }).getAttribute("aria-pressed")).toBe("true");
  const card = document.querySelector<HTMLElement>('[data-module="reports"]')!;
  await click(within(card).getByRole("button", { name: "Open Reports" }));
  expect(await screen.findByRole("heading", { name: "Reports", level: 1 })).toBeTruthy();
  expect(await fingerprint()).toBe(before);
});

it("modules that are not built for the app say so, have no switch, and Settings is always there", async () => {
  mockAccount();
  render(<App />);
  await openLibrary();
  for (const name of ["Ledgers", "Goals & Planning", "Household", "Multi-Currency", "Cash Flow Forecast"]) {
    expect(screen.queryByRole("switch", { name: `Show ${name} in the sidebar` }), name).toBeNull();
  }
  const forecast = document.querySelector<HTMLElement>('[data-module="forecast"]')!;
  expect(forecast.dataset.availability).toBe("unsupported");
  expect(within(forecast).getByText("Not in the app yet")).toBeTruthy();
  expect(within(forecast).getByRole("button", { name: /Open on the website/ })).toBeTruthy();
  const fixedAssets = document.querySelector<HTMLElement>('[data-module="fixed_assets"]')!;
  expect(within(fixedAssets).getByText("Not implemented")).toBeTruthy();
  expect(within(fixedAssets).queryAllByRole("button")).toHaveLength(0);
  fireEvent.click(screen.getByRole("button", { name: "Not available yet" }));
  expect(document.querySelectorAll("#feature-library li[data-module]")).toHaveLength(2);
  fireEvent.click(screen.getByRole("button", { name: "Hidden" }));
  expect([...document.querySelectorAll<HTMLElement>("#feature-library li[data-module]")].map((item) => item.dataset.module)).toEqual(["transactions", "accounts", "categories", "budgets", "recurring", "reports", "import", "receipts", "data_management"]);
  expect(screen.getByText("Always shown")).toBeTruthy();
  // Hiding every default entry, still leaves Settings.
  fireEvent.click(screen.getByRole("button", { name: "All" }));
  for (const name of ["Financial Overview", "AI Insight"]) await click(switchFor(name));
  await waitFor(async () => expect((await labels()).filter((label) => label !== "Collapse sidebar")).toEqual(["Settings"]));
});

it("keeps Settings open in both modes and restores the sidebar without changing records", async () => {
  mockAccount();
  render(<App />);
  const navigation = await sidebar();
  const before = await fingerprint();
  await click(navigation.getByRole("button", { name: "Settings" }));
  await screen.findByRole("button", { name: "Open Feature Library" });
  const sectionIds = () => [...document.querySelectorAll("#settings-index button")].map((item) => item.textContent);
  const initial = sectionIds();
  expect(document.getElementById("settings-automation")).toBeTruthy();
  await click(screen.getByRole("button", { name: "Manual Accounting" }));
  expect(sectionIds()).toEqual(initial);
  const preview = within(screen.getByRole("region", { name: "Live sidebar preview" }));
  expect(preview.getAllByRole("listitem").map((item) => item.textContent?.trim())).toEqual(["Financial Overview", "AI Insight", "Settings"]);
  await click(switchFor("Data Management"));
  await click(switchFor("AI Insight"));
  expect(navigation.getByRole("button", { name: "Data Management" })).toBeTruthy();
  expect(preview.getAllByRole("listitem").map((item) => item.textContent?.trim())).toEqual(["Financial Overview", "Data Management", "Settings"]);
  expect(navigation.queryByRole("button", { name: "AI Insight" })).toBeNull();
  await click(screen.getByRole("button", { name: "Restore default sidebar" }));
  expect(navigation.queryByRole("button", { name: "Data Management" })).toBeNull();
  expect(navigation.getByRole("button", { name: "AI Insight" })).toBeTruthy();
  expect(preview.getAllByRole("listitem").map((item) => item.textContent?.trim())).toEqual(["Financial Overview", "AI Insight", "Settings"]);
  expect(screen.getByRole("button", { name: "Manual Accounting" }).getAttribute("aria-pressed")).toBe("true");
  expect(await fingerprint()).toEqual(before);
});

it("a module hidden from the sidebar still answers deep links, without a 'turned off' page", async () => {
  mockAccount();
  render(<App />);
  await screen.findByRole("navigation");
  const before = await fingerprint();
  await openLibrary();
  await click(switchFor("Transactions"));
  expect((await sidebar()).getByRole("button", { name: "Transactions" })).toBeTruthy();
  await click(switchFor("Transactions"));
  await waitFor(async () => expect((await sidebar()).queryByRole("button", { name: "Transactions" })).toBeNull());
  // A Siri / Shortcuts deep link targets a Transactions page.
  await act(async () => { window.location.hash = "#/capture/expense"; window.dispatchEvent(new HashChangeEvent("hashchange")); });
  expect(await screen.findByRole("heading", { name: "Transactions", level: 1 })).toBeTruthy();
  expect(document.getElementById("module-unavailable")).toBeNull();
  expect(screen.queryByText(/turned off/)).toBeNull();
  expect(await fingerprint()).toBe(before);
});

it("Settings is a registry of sections, with database management and an integrity check that changes nothing", async () => {
  mockAccount();
  render(<App />);
  await click((await sidebar()).getByRole("button", { name: "Settings" }));
  const index = await screen.findByRole("group", { name: "Settings sections" });
  expect(within(index).getAllByRole("button").map((button) => button.dataset.settingsArea))
    .toEqual(["features", "database", "data", "sync", "account", "appearance", "rules", "modules"]);
  for (const area of ["features", "database", "data", "sync", "account", "appearance", "rules", "modules"]) expect(document.getElementById(`settings-area-${area}`), area).toBeTruthy();
  const database = document.getElementById("settings-database")!;
  expect(within(database).getByText("Library book")).toBeTruthy();
  const before = await fingerprint();
  await click(within(database).getByRole("button", { name: "Check integrity" }));
  await waitFor(() => expect(database.querySelector("[data-integrity]")?.getAttribute("data-integrity")).toBe("ok"));
  expect(await fingerprint()).toBe(before);
  // Capabilities that do not exist yet are labelled and have no button.
  for (const key of ["scheduled", "repair"]) {
    const item = database.querySelector<HTMLElement>(`[data-capability="${key}"]`)!;
    expect(item.dataset.status).toBe("not_yet");
    expect(within(item).queryAllByRole("button")).toHaveLength(0);
  }
  // Backup & restore opens the database manager at the backup panel.
  await click(within(database.querySelector<HTMLElement>('[data-capability="backup"]')!).getByRole("button", { name: "Open" }));
  expect(await screen.findByRole("heading", { name: "Data", level: 1 })).toBeTruthy();
  // Feature settings are listed for usable modules even though they are not in the sidebar.
  await click((await sidebar()).getByRole("button", { name: "Settings" }));
  expect([...document.querySelectorAll<HTMLElement>("[data-settings-module]")].map((item) => item.dataset.settingsModule)).toEqual(["accounts", "categories", "budgets", "recurring"]);
});

it("Add & Sync lists four capabilities, marks bank connections as Coming soon and opens the existing tools", async () => {
  mockAccount();
  render(<App />);
  await screen.findByRole("navigation");
  await click(screen.getByRole("button", { name: "Add & Sync" }));
  const connect = await screen.findByText("Connect Financial Accounts");
  const card = connect.closest("li")!;
  expect(within(card).getByText("Coming soon")).toBeTruthy();
  expect(within(card).queryAllByRole("button")).toHaveLength(0); // no fake connection flow
  expect(screen.getByRole<HTMLButtonElement>("button", { name: "Review typed entry" }).disabled).toBe(false);
  expect(screen.getByRole("textbox", { name: "Describe an expense or income" })).toBeTruthy();
  await click(screen.getAllByRole("button", { name: "Import statements" })[1]);
  await waitFor(() => expect(screen.getAllByRole("button", { name: "Import statements" })[0].getAttribute("aria-current")).toBe("page"));
});

it("AI Insight is usable by default and offers AI categorization without the Categories module", async () => {
  mockAccount();
  render(<App />);
  await click((await sidebar()).getByRole("button", { name: "AI Insight" }));
  await screen.findByRole("heading", { name: "AI Insight", level: 1 });
  expect(screen.getByRole("heading", { name: "Categorize with AI" })).toBeTruthy();
  expect(screen.getByRole("heading", { name: "Ask in plain words" })).toBeTruthy();
  expect(screen.getByText(/on the BillieWeather website for now/)).toBeTruthy();
});
