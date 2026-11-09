// @vitest-environment jsdom
// The "Show My Local Databases on the Website" setting and when the app reports.
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import initSqlJs from "sql.js";
import { migrate } from "./helpers";
import { sqljsDriver } from "../src/services/sqljsDriver";
import { API_ORIGIN } from "../src/services/account";

vi.mock("../src/services/platform", async () => {
  const SQL = await initSqlJs();
  const files = new Map<string, ReturnType<typeof sqljsDriver>>();
  return {
    isTauri: () => false,
    openDatabase: async (file = "billieweather.db") => {
      if (!files.has(file)) {
        const db = new SQL.Database();
        migrate(db);
        if (file === "billieweather.db") db.run("INSERT INTO settings (key, value) VALUES ('database_name','Home Mac')");
        files.set(file, sqljsDriver(db));
      }
      return { driver: files.get(file)!, persistent: true };
    },
    resetDatabases: () => files.clear(),
    deviceName: async () => "Jyun's MacBook",
    saveFile: async () => true,
  };
});
const account = { email: "jyun@example.com", nickname: "jyun", locale: "en", timeZone: null, usageRegion: "US", registeredAt: "2026-11-01T12:00:00Z", badges: [] };
vi.mock("../src/services/account", async (importOriginal) => ({ ...(await importOriginal<typeof import("../src/services/account")>()), fetchAccount: vi.fn(async () => account) }));
const { default: App } = await import("../src/App");
const platform = (await import("../src/services/platform")) as unknown as { resetDatabases: () => void };

let reports: Array<{ method: string; path: string; body: { database?: Record<string, unknown> } | null }>;
let online: boolean;

function mockServer() {
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = String(input);
    const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
    if (url.includes("/api/client/v1/devices")) {
      if (!online) throw new TypeError("offline");
      reports.push({ method: init?.method ?? "GET", path: url.replace(`${API_ORIGIN}/api/client/v1/devices`, ""), body: init?.body ? JSON.parse(String(init.body)) : null });
      return ok({ status: "applied" });
    }
    const path = url.replace(`${API_ORIGIN}/api/client/v1/finance`, "");
    if (path === "") return ok({ currency: null, name: null, version: "v1", statement_count: 0, transaction_count: 0, rule_count: 0, bank_account_count: 0, pending_import_count: 0, insight_count: 0, last_updated_at: null, period_start: null, period_end: null, storage_bytes: 0 });
    if (path === "/statements") return ok({ statements: [] });
    if (path === "/rules") return ok({ rules: [] });
    return ok({ transactions: [], next_after_id: null });
  });
}

async function openApp() {
  sessionStorage.setItem("billie.token", "tok");
  localStorage.setItem("billie.account", JSON.stringify(account));
  localStorage.setItem("billie.locale", "en");
  render(<App />);
  await screen.findByRole("heading", { name: "Dashboard" }).catch(() => undefined);
  await waitFor(() => expect(screen.getAllByRole("navigation").length).toBeGreaterThan(0));
}
const go = (name: string) => fireEvent.click(within(screen.getByRole("navigation")).getByRole("button", { name }));
const toggle = () => screen.getByRole("checkbox", { name: "Show My Local Databases on the Website" }) as HTMLInputElement;
const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 30)); });

beforeEach(() => { localStorage.clear(); sessionStorage.clear(); platform.resetDatabases(); reports = []; online = true; mockServer(); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

it("is off by default with the explanation shown, and opening the app reports nothing", async () => {
  await openApp();
  go("Settings");
  expect(toggle().checked).toBe(false);
  expect(screen.getByText(/When enabled, BillieWeather securely shares basic information about your local databases, such as their names, sizes, and record counts, so you can see them on the website\. Your financial records remain on your device\./)).toBeTruthy();
  await flush();
  expect(reports).toEqual([]);
});

it("turning it on reports each database; turning it off asks the server to remove them and says so only when confirmed", async () => {
  await openApp();
  go("Settings");
  await act(async () => fireEvent.click(toggle()));
  await waitFor(() => expect(reports.map((r) => r.method)).toEqual(["PUT"]));
  expect((reports[0].body!.database as { name: string; device_name: string }).name).toBe("Home Mac");
  expect((reports[0].body!.database as { device_name: string }).device_name).toBe("Jyun's MacBook");

  online = false;
  await act(async () => fireEvent.click(toggle()));
  expect(toggle().checked).toBe(false);
  await screen.findByText(/Removal requested\. Waiting for the server to confirm/);
  expect(screen.queryByText(/server confirmed/)).toBeNull();
});

it("a confirmed removal is reported to the person", async () => {
  await openApp();
  go("Settings");
  await act(async () => fireEvent.click(toggle()));
  await waitFor(() => expect(reports.length).toBe(1));
  await act(async () => fireEvent.click(toggle()));
  await screen.findByText("The server confirmed that the information this device shared was removed from the website.");
  expect(reports.at(-1)!.method).toBe("DELETE");
  expect(reports.at(-1)!.path).toMatch(/^\/[0-9a-f-]{36}\?sequence=\d+$/);
});

it("when already on, opening the app reports; creating, renaming and deleting a database report too; the id never changes on rename", async () => {
  localStorage.setItem("billie.report.enabled", JSON.stringify({ "jyun@example.com": true }));
  await openApp();
  await waitFor(() => expect(reports.length).toBe(1)); // after the app opened and sign-in succeeded
  const homeId = reports[0].path.split("/")[3];
  go("Data");
  await screen.findByRole("heading", { name: "Data", level: 1 });

  fireEvent.click(await screen.findByRole("button", { name: "New database" }));
  fireEvent.change(screen.getByLabelText("Name of the new database"), { target: { value: "Work" } });
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Create" })));
  await waitFor(() => expect(reports.filter((r) => r.method === "PUT" && (r.body!.database as { name: string }).name === "Work").length).toBe(1));

  const home = screen.getByRole("heading", { name: "Home Mac", level: 2 }).closest("section")! as HTMLElement;
  fireEvent.click(within(home).getByRole("button", { name: "Rename" }));
  fireEvent.change(within(home).getByLabelText("Name"), { target: { value: "Studio" } });
  await act(async () => fireEvent.click(within(home).getByRole("button", { name: "Save" })));
  await waitFor(() => expect(reports.some((r) => r.method === "PUT" && (r.body!.database as { name: string }).name === "Studio")).toBe(true));
  const renamed = reports.find((r) => r.method === "PUT" && (r.body!.database as { name: string }).name === "Studio")!;
  expect(renamed.path.split("/")[3]).toBe(homeId);
  expect(reports.filter((r) => r.path.includes(`/databases/${homeId}`) && r.method === "PUT").length).toBe(2);

  const work = screen.getByRole("heading", { name: "Work", level: 2 }).closest("section")! as HTMLElement;
  fireEvent.click(within(work).getByRole("button", { name: "Delete database" }));
  fireEvent.change(within(work).getByLabelText(/To confirm/), { target: { value: "delete" } });
  await act(async () => fireEvent.click(within(work).getByRole("button", { name: "Delete permanently" })));
  await waitFor(() => expect(reports.some((r) => r.method === "DELETE")).toBe(true));
  expect(reports.filter((r) => r.method === "DELETE").length).toBe(1);
  expect(JSON.stringify(reports)).not.toMatch(/amount|description|filename/);
});

it("reporting sets only Metadata Last Updated: Last Synced and Last Backed Up stay as they were, and no sync or upload request is made", async () => {
  await openApp();
  go("Settings");
  expect(screen.getByText(/^Metadata Last Updated: Not shared \(reporting is off\)/)).toBeTruthy();
  await act(async () => fireEvent.click(toggle()));
  await waitFor(() => expect(reports.length).toBe(1));
  await waitFor(() => expect(screen.queryByText(/Metadata Last Updated: Not shared/)).toBeNull());
  expect(screen.getByText(/^Metadata Last Updated: [A-Z][a-z]{2} \d/)).toBeTruthy();

  go("Data");
  await screen.findByRole("heading", { name: "Data", level: 1 });
  const home = (await screen.findByRole("heading", { name: "Home Mac", level: 2 })).closest("section")! as HTMLElement;
  const fact = (label: string) => within(home).getByText(label).nextElementSibling!.textContent;
  await waitFor(() => expect(fact("Metadata Last Updated")).toMatch(/^[A-Z][a-z]{2} \d/));
  expect(fact("Last Synced")).toBe("Never");
  expect(fact("Last Backed Up")).toBe("No backups yet");
  const calls = (fetch as unknown as { mock: { calls: Array<[RequestInfo | URL, RequestInit?]> } }).mock.calls;
  expect(calls.filter(([, init]) => init?.method === "POST")).toEqual([]);
  expect(calls.filter(([url, init]) => !String(url).includes("/devices/") && init?.method && init.method !== "GET")).toEqual([]);
});
