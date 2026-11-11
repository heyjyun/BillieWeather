// @vitest-environment jsdom
// Data page: every database (each local one and the cloud) with name, size, share and contents;
// naming, creating and deleting them (typed confirmation); syncing between them; and managing
// statements one at a time.
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
    // One in-memory database per file name, like the app's slot files.
    openDatabase: async (file = "billieweather.db") => {
      if (!files.has(file)) {
        const db = new SQL.Database();
        migrate(db);
        if (file === "billieweather.db") {
          db.run("INSERT INTO statements (filename, currency, sha256, transaction_count, imported_at) VALUES ('mine.csv','USD','m',1,'2026-01-01')");
          db.run("INSERT INTO transactions (statement_id, booked_on, description, amount_cents, category, updated_at) VALUES (1,'2026-01-02','LOCAL ONLY',-500,'Shopping','2026-01-02T10:00:00Z')");
          db.run("INSERT INTO settings (key, value) VALUES ('currency','USD')");
          db.run("INSERT INTO settings (key, value) VALUES ('database_name','Home Mac')");
          // A person who switched website download off in an older version (there is no switch any more).
          if ((globalThis as { __webSyncOff?: boolean }).__webSyncOff) db.run("INSERT INTO settings (key, value) VALUES ('web_sync_enabled','0')");
        }
        // A database whose entry in the device's list was lost (app storage cleared).
        if (file === "billieweather-2.db" && (globalThis as { __forgottenSlot?: boolean }).__forgottenSlot) {
          db.run("INSERT INTO statements (filename, currency, sha256, transaction_count, imported_at) VALUES ('old.csv','USD','o',1,'2026-01-01')");
          db.run("INSERT INTO transactions (statement_id, booked_on, description, amount_cents, category, updated_at) VALUES (1,'2026-01-02','FORGOTTEN ROW',-700,'Shopping','2026-01-02T10:00:00Z')");
          db.run("INSERT INTO settings (key, value) VALUES ('database_name','Old laptop')");
        }
        files.set(file, sqljsDriver(db));
      }
      return { driver: files.get(file)!, persistent: true };
    },
    resetDatabases: () => files.clear(),
    deviceName: async () => "Some Mac",
    saveFile: async () => true,
  };
});
const account = { email: "jyun@example.com", nickname: "jyun", locale: "en", timeZone: null, usageRegion: "US", registeredAt: "2026-11-01T12:00:00Z", badges: ["member"] };
vi.mock("../src/services/account", async (importOriginal) => ({ ...(await importOriginal<typeof import("../src/services/account")>()), fetchAccount: vi.fn(async () => account) }));

const { default: App } = await import("../src/App");
const platform = (await import("../src/services/platform")) as unknown as { resetDatabases: () => void };

function fakeCloud() {
  const cloud = { name: null as string | null, statements: [{ id: 501, filename: "web.csv", sha256: "w", rows: [["2026-03-01", "WEB ONE", "-1.0"], ["2026-03-02", "WEB TWO", "-2.0"]] }] };
  let version = 1;
  const requests: Array<{ method: string; path: string; body: unknown }> = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const path = String(input).replace(`${API_ORIGIN}/api/client/v1/finance`, "");
    const method = init?.method ?? "GET";
    requests.push({ method, path, body: init?.body });
    const ok = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
    const deleteMatch = /^\/statements\/(\d+)$/.exec(path);
    if (method === "DELETE" && deleteMatch) {
      cloud.statements = cloud.statements.filter((s) => s.id !== Number(deleteMatch[1]));
      version += 1;
      return ok({ deleted: { id: Number(deleteMatch[1]), transactions: 2 } });
    }
    if (method === "DELETE" && path === "?confirm=delete") {
      cloud.statements = [];
      version += 1;
      return ok({ deleted: {} });
    }
    if (method === "PATCH" && path === "") {
      cloud.name = (JSON.parse(String(init?.body)) as { name: string }).name || null;
      return ok({ name: cloud.name });
    }
    if (method === "POST" && path === "/statements") {
      const sent = (JSON.parse(String(init?.body)) as { statement: { filename: string; sha256: string; transactions: unknown[] } }).statement;
      const existing = cloud.statements.find((s) => s.sha256 === sent.sha256);
      if (existing) return ok({ id: existing.id, created: false });
      cloud.statements.push({ id: 900 + cloud.statements.length, filename: sent.filename, sha256: sent.sha256, rows: [] });
      version += 1;
      return ok({ id: 900, created: true }, 201);
    }
    const count = cloud.statements.reduce((sum, s) => sum + s.rows.length, 0);
    if (path === "") return ok({ currency: "USD", name: cloud.name, version: `v${version}`, statement_count: cloud.statements.length, transaction_count: count, rule_count: 0, bank_account_count: 1, pending_import_count: 0, insight_count: 0, last_updated_at: "2026-11-08T10:00:00Z", period_start: count ? "2026-03-01" : null, period_end: count ? "2026-03-02" : null, storage_bytes: count ? 2_621_440 : 0 });
    if (path === "/statements") return ok({ statements: cloud.statements.map((s) => ({ id: s.id, filename: s.filename, currency: "USD", sha256: s.sha256, transaction_count: s.rows.length, closing_balance: null, closing_balance_on: null, imported_at: "2026-03-05T00:00:00Z", period_start: "2026-03-01", period_end: "2026-03-02" })) });
    if (path === "/rules") return ok({ rules: [] });
    return ok({ transactions: cloud.statements.flatMap((s) => s.rows.map((r, i) => ({ id: s.id * 10 + i, statement_id: s.id, booked_on: r[0], description: r[1], amount: r[2], category: "Shopping", tax_review: false, excluded: false }))), next_after_id: null });
  });
  return { cloud, requests };
}

async function openData() {
  sessionStorage.setItem("billie.token", "tok");
  localStorage.setItem("billie.account", JSON.stringify(account));
  localStorage.setItem("billie.locale", "en");
  render(<App />);
  await screen.findByText(/Downloaded from your website account/);
  fireEvent.click(within(screen.getByRole("navigation")).getByRole("button", { name: "Data" }));
  await screen.findByRole("heading", { name: "Data", level: 1 });
}
const card = (name: string) => screen.getByRole("heading", { name, level: 2 }).closest("section")! as HTMLElement;
const fact = (section: HTMLElement, label: string) => within(section).getByText(label).nextElementSibling!.textContent;
const list = (name: string) => screen.getByRole("heading", { name }).closest("section")! as HTMLElement;
const rowFor = (section: HTMLElement, filename: string) => within(section).getByText(filename).closest("li")! as HTMLElement;
const click = (element: HTMLElement) => act(async () => { fireEvent.click(element); });

async function createDatabase(name: string, shown = name) {
  await click(screen.getByRole("button", { name: "New database" }));
  fireEvent.change(screen.getByLabelText("Name of the new database"), { target: { value: name } });
  await click(screen.getByRole("button", { name: "Create" }));
  await screen.findByText(`“${shown}” was created.`);
}

beforeEach(() => { localStorage.clear(); sessionStorage.clear(); platform.resetDatabases(); (globalThis as { __webSyncOff?: boolean }).__webSyncOff = false; });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

it("shows the cloud and each local database by name, with size, share of the total, contents and dates", async () => {
  fakeCloud();
  await openData();
  const device = card("Home Mac");
  await waitFor(() => expect(fact(device, "Statements")).toBe("2"));
  expect(fact(device, "Transactions")).toBe("3");
  expect(fact(device, "Size")).toMatch(/KB$/);
  expect(fact(device, "Dates")).toBe("2026-01-02 – 2026-03-02");
  expect(fact(device, "Where")).toBe("This app's private folder on this device");
  expect(within(device).getByText("In use")).toBeTruthy();
  const cloud = card("BillieWeather cloud");
  await waitFor(() => expect(fact(cloud, "Size")).toBe("about 2.5 MB"));
  expect(fact(cloud, "Transactions")).toBe("2");
  expect(fact(cloud, "Bank accounts")).toBe("1");
  // Shares add up: the cloud is almost all of the stored data, and both are listed under Storage.
  expect(fact(cloud, "Share of total")).toMatch(/^\d+%$/);
  expect(fact(device, "Share of total")).toMatch(/^(<1|\d+)%$/);
  const usage = list("Storage");
  expect(within(usage).getByText("Home Mac")).toBeTruthy();
  expect(within(usage).getByText("BillieWeather cloud")).toBeTruthy();
  expect(within(usage).getByText(/^Total: /)).toBeTruthy();
});

it("names the cloud database and shows its name", async () => {
  const { cloud } = fakeCloud();
  await openData();
  const section = await waitFor(() => card("BillieWeather cloud"));
  await waitFor(() => expect(fact(section, "Size")).toBe("about 2.5 MB"));
  await click(within(section).getByRole("button", { name: "Rename" }));
  fireEvent.change(within(section).getByLabelText("Name"), { target: { value: "  Family   books " } });
  await click(within(section).getByRole("button", { name: "Save" }));
  await screen.findByText("Database renamed.");
  expect(cloud.name).toBe("Family books");
  await waitFor(() => expect(screen.getByRole("heading", { name: "Family books", level: 2 })).toBeTruthy());
});

it("creates, names and switches between local databases", async () => {
  fakeCloud();
  await openData();
  await createDatabase("  Work   laptop ", "Work laptop");
  const work = card("Work laptop");
  expect(fact(work, "Statements")).toBe("0");
  expect(within(work).queryByText("In use")).toBeNull();
  expect(within(card("Home Mac")).getByText("In use")).toBeTruthy();
  expect(JSON.parse(localStorage.getItem("billie.databases")!)).toEqual({ ids: [1, 2], active: 1 });

  await click(within(work).getByRole("button", { name: "Use this database" }));
  await waitFor(() => expect(within(card("Work laptop")).getByText("In use")).toBeTruthy());
  expect(within(card("Home Mac")).queryByText("In use")).toBeNull();
  expect(list("Statements in “Work laptop”")).toBeTruthy();
  expect(JSON.parse(localStorage.getItem("billie.databases")!).active).toBe(2);

  await click(within(card("Work laptop")).getByRole("button", { name: "Rename" }));
  fireEvent.change(within(card("Work laptop")).getByLabelText("Name"), { target: { value: "Studio iMac" } });
  await click(within(card("Work laptop")).getByRole("button", { name: "Save" }));
  await waitFor(() => expect(card("Studio iMac")).toBeTruthy());
});

it("creating a database never wipes a database the device's list forgot", async () => {
  (globalThis as { __forgottenSlot?: boolean }).__forgottenSlot = true;
  try {
    fakeCloud();
    await openData();
    expect(JSON.parse(localStorage.getItem("billie.databases") ?? "null")?.ids ?? [1]).toEqual([1]);
    await createDatabase("Work");
    expect(card("Work")).toBeTruthy();
    const old = card("Old laptop");
    expect(fact(old, "Statements")).toBe("1");
    expect(JSON.parse(localStorage.getItem("billie.databases")!).ids).toEqual([1, 2, 3]);
  } finally {
    delete (globalThis as { __forgottenSlot?: boolean }).__forgottenSlot;
  }
});

it("deleting a database needs the typed word, says it can't be undone, and can be cancelled", async () => {
  fakeCloud();
  await openData();
  await createDatabase("Work");
  const work = card("Work");
  await click(within(work).getByRole("button", { name: "Delete database" }));
  expect(within(work).getByText(/It cannot be recovered\./)).toBeTruthy();
  const confirm = within(work).getByRole("button", { name: "Delete permanently" }) as HTMLButtonElement;
  expect(confirm.disabled).toBe(true);
  fireEvent.change(within(work).getByLabelText(/To confirm, type “delete”/), { target: { value: "dele" } });
  expect(confirm.disabled).toBe(true);
  await click(within(work).getByRole("button", { name: "Cancel" }));
  expect(within(work).queryByText(/It cannot be recovered\./)).toBeNull();

  await click(within(work).getByRole("button", { name: "Delete database" }));
  fireEvent.change(within(work).getByLabelText(/To confirm, type “delete”/), { target: { value: "Delete" } });
  await click(within(work).getByRole("button", { name: "Delete permanently" }));
  await screen.findByText("“Work” was deleted.");
  await waitFor(() => expect(screen.queryByRole("heading", { name: "Work", level: 2 })).toBeNull());
  expect(JSON.parse(localStorage.getItem("billie.databases")!).ids).toEqual([1]);
  // Home Mac is untouched.
  expect(fact(card("Home Mac"), "Statements")).toBe("2");
});

it("deleting the only local database empties it but keeps it", async () => {
  fakeCloud();
  await openData();
  const home = card("Home Mac");
  await waitFor(() => expect(fact(home, "Statements")).toBe("2"));
  await click(within(home).getByRole("button", { name: "Delete database" }));
  expect(within(home).getByText(/your only database on this device/)).toBeTruthy();
  fireEvent.change(within(home).getByLabelText(/To confirm/), { target: { value: "delete" } });
  await click(within(home).getByRole("button", { name: "Delete permanently" }));
  await screen.findByText("“Home Mac” was deleted.");
  await waitFor(() => expect(fact(card("Home Mac"), "Statements")).toBe("0"));
  expect(fact(card("Home Mac"), "Transactions")).toBe("0");
});

it("deleting the cloud database asks for the typed word first, then removes it; devices keep their copies", async () => {
  const { cloud, requests } = fakeCloud();
  await openData();
  const section = card("BillieWeather cloud");
  await waitFor(() => expect(fact(section, "Statements")).toBe("1"));
  await click(within(section).getByRole("button", { name: "Delete database" }));
  expect(within(section).getByText(/for the website and all your devices/)).toBeTruthy();
  expect((within(section).getByRole("button", { name: "Delete permanently" }) as HTMLButtonElement).disabled).toBe(true);
  expect(requests.some((r) => r.method === "DELETE")).toBe(false);
  fireEvent.change(within(section).getByLabelText(/To confirm/), { target: { value: "delete" } });
  await click(within(section).getByRole("button", { name: "Delete permanently" }));
  await screen.findByText("“BillieWeather cloud” was deleted.");
  expect(cloud.statements).toEqual([]);
  expect(requests.filter((r) => r.method === "DELETE")).toEqual([{ method: "DELETE", path: "?confirm=delete", body: undefined }]);
  // The website copy on this device became its own data: it is still here.
  await waitFor(() => expect(fact(card("Home Mac"), "Statements")).toBe("2"));
  expect(within(list("Statements in “Home Mac”")).getByText("web.csv")).toBeTruthy();
});

it("syncs one local database into another: shows what will be added, adds only that, and a second run has nothing to add", async () => {
  const { requests } = fakeCloud();
  await openData();
  await createDatabase("Work");
  const from = screen.getByRole("combobox", { name: "From" });
  const to = screen.getByRole("combobox", { name: "To" });
  fireEvent.change(from, { target: { value: "1" } });
  fireEvent.change(to, { target: { value: "2" } });
  const panel = list("Sync between databases");
  await waitFor(() => expect(within(panel).getByText(/2 new statements \(3 transactions\) will be added to “Work”\. 0 already there\./)).toBeTruthy());
  expect(panel.querySelector('[data-sync-status="from"]')!.textContent).toMatch(/^2 statements · 3 transactions · last changed /);
  expect(panel.querySelector('[data-sync-status="to"]')!.textContent).toMatch(/^0 statements · 0 transactions/);
  expect(within(panel).getByText(/nothing is stored in the cloud/)).toBeTruthy();

  await click(within(panel).getByRole("button", { name: "Sync Now" }));
  await click(within(panel).getByRole("button", { name: "Confirm Sync" }));
  await screen.findByText("Added 2 statements (3 transactions) to “Work”.");
  expect(fact(card("Work"), "Statements")).toBe("2");
  expect(fact(card("Work"), "Transactions")).toBe("3");
  expect(fact(card("Home Mac"), "Statements")).toBe("2");
  expect(requests.some((r) => r.method === "POST")).toBe(false); // not ticked: nothing sent to the cloud

  await waitFor(() => expect(within(panel).getByText("“Work” already has everything from “Home Mac”.")).toBeTruthy());
  expect((within(panel).getByRole("button", { name: "Sync Now" }) as HTMLButtonElement).disabled).toBe(true);
});

it("refuses to sync a database onto itself", async () => {
  fakeCloud();
  await openData();
  await createDatabase("Work");
  fireEvent.change(screen.getByRole("combobox", { name: "From" }), { target: { value: "1" } });
  fireEvent.change(screen.getByRole("combobox", { name: "To" }), { target: { value: "1" } });
  expect(screen.getByText("Choose two different databases.")).toBeTruthy();
  expect((within(list("Sync between databases")).getByRole("button", { name: "Sync Now" }) as HTMLButtonElement).disabled).toBe(true);
});

it("with the box ticked, a local-to-local sync also keeps the statements in the cloud", async () => {
  const { cloud, requests } = fakeCloud();
  await openData();
  await createDatabase("Work");
  fireEvent.change(screen.getByRole("combobox", { name: "From" }), { target: { value: "1" } });
  fireEvent.change(screen.getByRole("combobox", { name: "To" }), { target: { value: "2" } });
  const panel = list("Sync between databases");
  await click(within(panel).getByRole("checkbox", { name: "Also keep a copy in the cloud" }));
  await click(within(panel).getByRole("button", { name: "Sync Now" }));
  await click(within(panel).getByRole("button", { name: "Confirm Sync" }));
  await screen.findByText(/Added 2 statements \(3 transactions\) to “Work”\. Also saved in the cloud: 1\./);
  const posts = requests.filter((r) => r.method === "POST");
  expect(posts.length).toBe(2); // mine.csv is new to the cloud; web.csv was already there
  const sent = JSON.parse(String(posts.find((r) => String(r.body).includes("mine.csv"))!.body)).statement;
  expect(sent.transactions).toEqual([{ booked_on: "2026-01-02", description: "LOCAL ONLY", amount: "-5.0", category: "Shopping", tax_review: false, excluded: false }]);
  expect(cloud.statements.map((s) => s.filename)).toContain("mine.csv");
});

it("copies the cloud into a local database, and a local database up to the cloud", async () => {
  const { cloud } = fakeCloud();
  await openData();
  await createDatabase("Work");
  const panel = list("Sync between databases");
  fireEvent.change(screen.getByRole("combobox", { name: "From" }), { target: { value: "cloud" } });
  fireEvent.change(screen.getByRole("combobox", { name: "To" }), { target: { value: "2" } });
  await waitFor(() => expect(within(panel).getByText(/1 new statements \(2 transactions\) will be added to “Work”/)).toBeTruthy());
  await click(within(panel).getByRole("button", { name: "Sync Now" }));
  await click(within(panel).getByRole("button", { name: "Confirm Sync" }));
  await screen.findByText("Added 1 statements (2 transactions) to “Work”.");
  expect(fact(card("Work"), "Transactions")).toBe("2");
  expect(cloud.statements.length).toBe(1); // nothing is ever removed by a sync

  fireEvent.change(screen.getByRole("combobox", { name: "From" }), { target: { value: "2" } });
  fireEvent.change(screen.getByRole("combobox", { name: "To" }), { target: { value: "cloud" } });
  expect(within(panel).getByText(/Statements sent to the cloud are saved in your account/)).toBeTruthy();
});

it("removing a statement needs a second, explicit confirmation and can be cancelled", async () => {
  fakeCloud();
  await openData();
  const section = list("Statements in “Home Mac”");
  await waitFor(() => rowFor(section, "mine.csv"));
  const row = rowFor(section, "mine.csv");
  fireEvent.click(within(row).getByRole("button", { name: "Remove from this device" }));
  expect(within(row).getByText("“mine.csv” is only on this device. Removing it permanently deletes its 1 transactions.")).toBeTruthy();
  fireEvent.click(within(row).getByRole("button", { name: "Cancel" }));
  expect(within(row).queryByText(/permanently deletes/)).toBeNull();

  fireEvent.click(within(row).getByRole("button", { name: "Remove from this device" }));
  await act(async () => fireEvent.click(within(row).getByRole("button", { name: "Remove" })));
  await screen.findByText("“mine.csv” was removed from this device.");
  await waitFor(() => expect(within(section).queryByText("mine.csv")).toBeNull());
});

it("a website copy removed from this device stays in the cloud, is not re-downloaded, and can be downloaded again", async () => {
  const { requests } = fakeCloud();
  await openData();
  const here = list("Statements in “Home Mac”");
  await waitFor(() => rowFor(here, "web.csv"));
  const row = rowFor(here, "web.csv");
  fireEvent.click(within(row).getByRole("button", { name: "Remove from this device" }));
  expect(within(row).getByText(/It stays in the cloud/)).toBeTruthy();
  await act(async () => fireEvent.click(within(row).getByRole("button", { name: "Remove" })));
  const inCloud = () => list("Statements in “BillieWeather cloud”");
  await waitFor(() => expect(within(rowFor(inCloud(), "web.csv")).getByText("Not on this device")).toBeTruthy());
  expect(requests.some((r) => r.method === "DELETE")).toBe(false);

  await act(async () => fireEvent.click(within(rowFor(inCloud(), "web.csv")).getByRole("button", { name: "Download to this device" })));
  await waitFor(() => expect(within(rowFor(inCloud(), "web.csv")).getByText("On this device")).toBeTruthy());
  expect(within(list("Statements in “Home Mac”")).getByText("web.csv")).toBeTruthy();
});

it("deletes one statement from the cloud after confirmation; this device's copy follows", async () => {
  const { cloud, requests } = fakeCloud();
  await openData();
  const inCloud = () => list("Statements in “BillieWeather cloud”");
  await waitFor(() => rowFor(inCloud(), "web.csv"));
  const row = rowFor(inCloud(), "web.csv");
  fireEvent.click(within(row).getByRole("button", { name: "Delete from cloud" }));
  expect(within(row).getByText(/Delete “web.csv” \(2 transactions\) from the cloud\?/)).toBeTruthy();
  await act(async () => fireEvent.click(within(row).getByRole("button", { name: "Delete from cloud" })));
  await screen.findByText("“web.csv” was deleted from the cloud.");
  expect(cloud.statements).toEqual([]);
  expect(requests.filter((r) => r.method === "DELETE")).toEqual([{ method: "DELETE", path: "/statements/501", body: undefined }]);
  const here = list("Statements in “Home Mac”");
  await waitFor(() => expect(within(here).queryByText("web.csv")).toBeNull());
  expect(within(here).getByText("mine.csv")).toBeTruthy();
});

it("a sync only starts after a confirmation that names the source, the destination, the data scope and where it travels", async () => {
  const { requests } = fakeCloud();
  await openData();
  await createDatabase("Work");
  fireEvent.change(screen.getByRole("combobox", { name: "From" }), { target: { value: "1" } });
  fireEvent.change(screen.getByRole("combobox", { name: "To" }), { target: { value: "2" } });
  const panel = list("Sync between databases");
  await waitFor(() => expect(within(panel).getByText(/will be added to “Work”/)).toBeTruthy());
  await click(within(panel).getByRole("button", { name: "Sync Now" }));
  const confirm = within(panel).getByRole("group", { name: "Confirm sync" });
  expect(within(confirm).getByText("From").nextElementSibling!.textContent).toBe("Home Mac");
  expect(within(confirm).getByText("To").nextElementSibling!.textContent).toBe("Work");
  expect(within(confirm).getByText("Data scope").nextElementSibling!.textContent).toBe("2 new statements (3 transactions) and remembered rules will be copied. Nothing is deleted from either side.");
  expect(within(confirm).getByText("Stays on this device. Nothing is sent to the cloud.")).toBeTruthy();
  expect(fact(card("Work"), "Statements")).toBe("0"); // nothing happened yet
  await click(within(confirm).getByRole("button", { name: "Cancel" }));
  expect(within(panel).queryByRole("group", { name: "Confirm sync" })).toBeNull();
  expect(fact(card("Work"), "Statements")).toBe("0");
  expect(requests.some((r) => r.method === "POST")).toBe(false);
});

it("the confirmation says when data is sent to the cloud", async () => {
  fakeCloud();
  await openData();
  await createDatabase("Work");
  fireEvent.change(screen.getByRole("combobox", { name: "From" }), { target: { value: "1" } });
  fireEvent.change(screen.getByRole("combobox", { name: "To" }), { target: { value: "cloud" } });
  const panel = list("Sync between databases");
  await click(within(panel).getByRole("button", { name: "Sync Now" }));
  expect(within(panel).getByText("These statements are sent to your BillieWeather cloud account.")).toBeTruthy();
});

it("Metadata Last Updated, Last Synced and Last Backed Up are separate; only a confirmed sync sets Last Synced; backup is not available", async () => {
  fakeCloud();
  await openData();
  await createDatabase("Work");
  const home = card("Home Mac");
  await waitFor(() => expect(fact(card("Home Mac"), "Metadata Last Updated")).toMatch(/^[A-Z][a-z]{2} \d/)); // reported automatically
  expect(fact(home, "Last Synced")).toBe("Never");
  expect(fact(home, "Last Backed Up")).toBe("No backups yet");
  expect(screen.getByText(/Metadata Last Updated only means basic facts about a database/)).toBeTruthy();

  fireEvent.change(screen.getByRole("combobox", { name: "From" }), { target: { value: "1" } });
  fireEvent.change(screen.getByRole("combobox", { name: "To" }), { target: { value: "2" } });
  const panel = list("Sync between databases");
  await click(within(panel).getByRole("button", { name: "Sync Now" }));
  expect(fact(card("Work"), "Last Synced")).toBe("Never"); // opening the confirmation is not a sync
  await click(within(panel).getByRole("button", { name: "Confirm Sync" }));
  await screen.findByText(/Added 2 statements/);
  await waitFor(() => expect(fact(card("Work"), "Last Synced")).not.toBe("Never"));
  expect(fact(card("Home Mac"), "Last Synced")).not.toBe("Never");
  expect(within(card("Work")).getByText("Metadata Last Updated")).not.toBe(within(card("Work")).getByText("Last Synced")); // separate rows
  expect(fact(card("Work"), "Last Backed Up")).toBe("No backups yet");

  const backup = screen.getByRole("heading", { name: /Cloud backup/ }).closest("section")! as HTMLElement;
  const button = within(backup).getByRole("button", { name: /Back Up Now/ }) as HTMLButtonElement;
  expect(button.disabled).toBe(true);
  expect(button.textContent).toContain("Coming Soon");
});

it("Settings has no website-data section any more; the website download still happens on its own", async () => {
  const { requests } = fakeCloud();
  await openData(); // waits for "Downloaded from your website account"
  expect(requests.some((r) => r.method === "GET" && r.path === "/statements")).toBe(true);
  fireEvent.click(within(screen.getByRole("navigation")).getByRole("button", { name: "Settings" }));
  await screen.findByRole("heading", { name: "Settings & privacy", level: 1 });
  expect(screen.queryByRole("heading", { name: "Website data" })).toBeNull();
  expect(screen.queryByRole("checkbox", { name: /Download my website data/ })).toBeNull();
  expect(screen.queryByRole("button", { name: "Check now" })).toBeNull();
});

it("if website download was switched off before, Download to this device still works and turns it back on", async () => {
  (globalThis as { __webSyncOff?: boolean }).__webSyncOff = true;
  fakeCloud();
  sessionStorage.setItem("billie.token", "tok");
  localStorage.setItem("billie.account", JSON.stringify(account));
  localStorage.setItem("billie.locale", "en");
  render(<App />);
  fireEvent.click(within(await screen.findByRole("navigation")).getByRole("button", { name: "Data" }));
  const inCloud = () => list("Statements in “BillieWeather cloud”");
  await waitFor(() => expect(within(rowFor(inCloud(), "web.csv")).getByText("Not on this device")).toBeTruthy());
  expect(screen.queryByText(/Turn on website download in Settings/)).toBeNull();
  const button = within(rowFor(inCloud(), "web.csv")).getByRole("button", { name: "Download to this device" }) as HTMLButtonElement;
  expect(button.disabled).toBe(false);
  await click(button);
  await waitFor(() => expect(within(rowFor(inCloud(), "web.csv")).getByText("On this device")).toBeTruthy());
  expect(within(list("Statements in “Home Mac”")).getByText("web.csv")).toBeTruthy();
});
