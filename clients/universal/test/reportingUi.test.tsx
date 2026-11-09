// @vitest-environment jsdom
// Local database metadata is reported automatically (there is no switch), and when the app reports.
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

beforeEach(() => { localStorage.clear(); sessionStorage.clear(); platform.resetDatabases(); reports = []; online = true; mockServer(); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

it("there is no switch and no separate section: opening the app reports each database", async () => {
  await openApp();
  await waitFor(() => expect(reports.map((r) => r.method)).toEqual(["PUT"]));
  expect((reports[0].body!.database as { name: string }).name).toBe("Home Mac");
  expect((reports[0].body!.database as { device_name: string }).device_name).toBe("Jyun's MacBook");
  go("Settings");
  await screen.findByRole("heading", { name: "Settings & privacy", level: 1 });
  expect(screen.queryByRole("heading", { name: /Local databases on the website/ })).toBeNull();
  expect(screen.queryByText(/Metadata Last Updated/)).toBeNull();
  expect(screen.queryByRole("checkbox", { name: /local databases/i })).toBeNull();
  // The "Where your data lives" section is gone from Settings.
  expect(screen.queryByText(/Where your data lives|Encryption at rest/)).toBeNull();
  expect(screen.queryByRole("button", { name: "Sync Now…" })).toBeNull();
});

it("offline, the app works and a deleted database's removal is shown as pending", async () => {
  online = false;
  await openApp();
  go("Data");
  await screen.findByRole("heading", { name: "Data", level: 1 });
  fireEvent.click(await screen.findByRole("button", { name: "New database" }));
  fireEvent.change(screen.getByLabelText("Name of the new database"), { target: { value: "Work" } });
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Create" })));
  await screen.findByText("“Work” was created.");
  expect(reports).toEqual([]);
  const home = screen.getByRole("heading", { name: "Home Mac", level: 2 }).closest("section")! as HTMLElement;
  expect(within(home).getByText("Metadata Last Updated").nextElementSibling!.textContent).toBe("Not reported yet");
});

it("opening the app reports; creating, renaming and deleting a database report too; the id never changes on rename", async () => {
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
  await waitFor(() => expect(reports.length).toBe(1));
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

it("a database card's Sync Now to… picks it as the source and moves to the destination; nothing is copied until confirmed", async () => {
  await openApp();
  go("Data");
  const home = (await screen.findByRole("heading", { name: "Home Mac", level: 2 })).closest("section")! as HTMLElement;
  expect(within(home).getByRole("button", { name: "Rename" })).toBeTruthy();
  expect(within(home).getByRole("button", { name: "Delete database" })).toBeTruthy();
  const before = (fetch as unknown as { mock: { calls: unknown[] } }).mock.calls.length;
  await act(async () => fireEvent.click(within(home).getByRole("button", { name: "Sync Now to…" })));
  const panel = screen.getByRole("heading", { name: "Sync between databases" }).closest("section")! as HTMLElement;
  expect((within(panel).getByRole("combobox", { name: "From" }) as HTMLSelectElement).selectedOptions[0].textContent).toBe("Home Mac");
  await waitFor(() => expect(document.activeElement).toBe(within(panel).getByRole("combobox", { name: "To" })));
  expect(within(panel).queryByRole("group", { name: "Confirm sync" })).toBeNull();
  const after = (fetch as unknown as { mock: { calls: Array<[RequestInfo | URL, RequestInit?]> } }).mock.calls.slice(before);
  expect(after.filter(([, init]) => init?.method && init.method !== "GET")).toEqual([]);
});

it("in Chinese, the disclosure, the three states and the sync buttons are all in Chinese", async () => {
  account.locale = "zh-CN";
  try {
    sessionStorage.setItem("billie.token", "tok");
    localStorage.setItem("billie.account", JSON.stringify(account));
    localStorage.setItem("billie.locale", "zh-CN");
    render(<App />);
    await screen.findByRole("button", { name: "设置" });
  } finally {
    account.locale = "en";
  }
  fireEvent.click(within(screen.getByRole("navigation")).getByRole("button", { name: "设置" }));
  await screen.findByRole("heading", { name: "设置与隐私", level: 1 });
  expect(screen.queryByText(/并在网站上显示本地数据库的基本信息/)).toBeNull();
  expect(screen.queryByText(/Local databases on the website|Metadata Last Updated|Sync Now/)).toBeNull();
  fireEvent.click(within(screen.getByRole("navigation")).getByRole("button", { name: "数据管理" }));
  const home = (await screen.findByRole("heading", { name: "Home Mac", level: 2 })).closest("section")! as HTMLElement;
  expect(within(home).getByText("元数据最近更新")).toBeTruthy();
  expect(within(home).getByText("最近同步")).toBeTruthy();
  expect(within(home).getByText("最近备份")).toBeTruthy();
  expect(screen.getByRole("button", { name: /立即备份 · 即将推出/ })).toBeTruthy();
  expect(screen.getByRole("button", { name: "立即同步" })).toBeTruthy();
  expect(within(home).getByRole("button", { name: "立即同步到…" })).toBeTruthy();
  expect(within(home).getByRole("button", { name: "重命名" })).toBeTruthy();
  expect(screen.queryByText(/Coming Soon|Back Up Now|Last Synced/)).toBeNull();
});
