// @vitest-environment jsdom
// Feature Library through the real app shell (Phase 1a), with synthetic data only: the default sidebar,
// turning modules on and off, persistence across a restart, safe "turned off" pages, Coming soon modules,
// Add & Sync, and the guarantee that none of it changes a financial record or Manual Mode.
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
const labels = async () => (await sidebar()).getAllByRole("button").map((button) => button.textContent?.trim()).filter((text) => text && text !== "");
const click = async (element: HTMLElement) => act(async () => { fireEvent.click(element); });
const fingerprint = async () => JSON.stringify(await files.get("billieweather.db")!.select("SELECT * FROM transactions ORDER BY id"));

async function openLibrary() {
  await click((await sidebar()).getByRole("button", { name: "Settings" }));
  await click(await screen.findByRole("button", { name: "Open Feature Library" }));
  await screen.findByRole("heading", { name: "Feature Library", level: 1 });
}
const switchFor = (name: string) => screen.getByRole("switch", { name });

it("a new person sees Transactions, AI Assistant and Settings; the tabs are Overview, All Transactions, Add & Sync", async () => {
  mockAccount();
  render(<App />);
  await waitFor(async () => expect((await labels()).filter((label) => label !== "Collapse sidebar")).toEqual(["Transactions", "AI Assistant", "Settings"]));
  expect(screen.getByRole("button", { name: "Overview" }).getAttribute("aria-current")).toBe("page");
  expect(screen.getByRole("button", { name: "All Transactions" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Add & Sync" })).toBeTruthy();
});

it("turns a module on and off from the library, keeps it after a restart, and never touches records", async () => {
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

  // Off again: hidden, data unchanged; Default/Manual is not affected.
  await openLibrary();
  await click(switchFor("Reports"));
  await waitFor(async () => expect((await sidebar()).queryByRole("button", { name: "Reports" })).toBeNull());
  expect(screen.getByRole("button", { name: "Default" }).getAttribute("aria-pressed")).toBe("true");
  expect(await fingerprint()).toBe(before);
});

it("Coming soon modules are shown but cannot be turned on; Settings is always there", async () => {
  mockAccount();
  render(<App />);
  await openLibrary();
  for (const name of ["Ledgers", "Goals & Planning", "Household", "Multi-Currency", "Cash Flow Forecast"]) {
    const control = switchFor(name);
    expect((control as HTMLButtonElement).disabled).toBe(true);
    expect(control.getAttribute("aria-checked")).toBe("false");
  }
  fireEvent.click(screen.getByRole("button", { name: "Coming soon" }));
  expect(screen.getAllByRole("switch").length).toBe(5);
  expect(screen.getByText("Settings is always in the sidebar and can't be turned off.")).toBeTruthy();
  // Turning off both core modules still leaves Settings.
  fireEvent.click(screen.getByRole("button", { name: "All" }));
  await click(switchFor("Transactions"));
  await click(switchFor("AI Assistant"));
  await waitFor(async () => expect((await labels()).filter((label) => label !== "Collapse sidebar")).toEqual(["Settings"]));
});

it("a page of a hidden module shows a safe 'turned off' page that can turn it on, without switching Manual Mode on", async () => {
  mockAccount();
  render(<App />);
  await screen.findByRole("navigation");
  const before = await fingerprint();
  await openLibrary();
  await click(switchFor("Transactions"));
  // A Siri / Shortcuts deep link still targets a Transactions page (new expense = Manual Mode intent).
  await act(async () => { window.location.hash = "#/capture/expense"; window.dispatchEvent(new HashChangeEvent("hashchange")); });
  await screen.findByRole("heading", { name: "Transactions is turned off", level: 1 });
  expect(screen.getByRole("button", { name: "Default" }).getAttribute("aria-pressed")).toBe("true"); // mode unchanged
  expect(screen.queryByRole("button", { name: "Overview" })).toBeNull();
  expect(await fingerprint()).toBe(before);
  // Turning it on from here opens the page; the data is all there.
  await click(screen.getByRole("button", { name: "Turn on Transactions" }));
  await waitFor(() => expect(screen.queryByRole("heading", { name: "Transactions is turned off" })).toBeNull());
  expect((await sidebar()).getByRole("button", { name: "Transactions" })).toBeTruthy();
  expect(await fingerprint()).toBe(before);
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
  expect(screen.getByText(/Voice entry, natural-language entry and Siri Shortcuts are coming later/)).toBeTruthy();
  await click(screen.getAllByRole("button", { name: "Import statements" })[1]);
  await waitFor(() => expect(screen.getAllByRole("button", { name: "Import statements" })[0].getAttribute("aria-current")).toBe("page"));
});

it("AI Assistant is usable by default and offers AI categorization without the Categories module", async () => {
  mockAccount();
  render(<App />);
  await click((await sidebar()).getByRole("button", { name: "AI Assistant" }));
  await screen.findByRole("heading", { name: "AI Assistant", level: 1 });
  expect(screen.getByRole("heading", { name: "Categorize with AI" })).toBeTruthy();
  expect(screen.getByRole("heading", { name: "Ask in plain words" })).toBeTruthy();
  expect(screen.getByText(/on the BillieWeather website for now/)).toBeTruthy();
});
