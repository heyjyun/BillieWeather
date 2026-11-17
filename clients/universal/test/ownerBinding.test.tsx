// @vitest-environment jsdom
// P0-1 (invariant I-13): two accounts on one device. Signing in as another account never shows,
// opens, downloads into, reports or deletes the first account's database. Synthetic data only.
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import initSqlJs from "sql.js";
import { migrate } from "./helpers";
import { sqljsDriver } from "../src/services/sqljsDriver";
import { API_ORIGIN } from "../src/services/account";

const files = new Map<string, ReturnType<typeof sqljsDriver>>();
vi.mock("../src/services/platform", async () => {
  const SQL = await initSqlJs();
  return {
    isTauri: () => false,
    openDatabase: async (file = "billieweather.db") => {
      if (!files.has(file)) {
        const db = new SQL.Database();
        migrate(db);
        if (file === "billieweather.db" && (globalThis as { __legacy?: boolean }).__legacy) {
          // Alice's database from before owners were recorded.
          db.run("INSERT INTO statements (filename, currency, sha256, transaction_count, imported_at) VALUES ('alice.csv','USD','a',1,'2026-01-01')");
          db.run("INSERT INTO transactions (statement_id, booked_on, description, amount_cents, category, updated_at, kind) VALUES (1,'2026-01-02','ALICE PRIVATE ROW',-500,'Shopping','x','expense')");
          db.run("INSERT INTO settings (key, value) VALUES ('currency','USD'), ('database_name','Alice Mac')");
        }
        const bound = (globalThis as { __boundOwner?: string | null }).__boundOwner;
        if (file === "billieweather.db" && bound) db.run("INSERT INTO settings (key, value) VALUES ('owner_account_id', ?)", [bound]);
        files.set(file, sqljsDriver(db));
      }
      return { driver: files.get(file)!, persistent: true };
    },
    deviceName: async () => "Shared Mac",
    deviceIdentity: async () => null,
    saveFile: async () => true,
  };
});

let who = { email: "alice@example.com", owner_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" };
const accountJson = () => ({ email: who.email, nickname: null, locale: "en", time_zone: null, usage_region: "US", registered_at: null, badges: [], owner_id: who.owner_id });
const webRequests: string[] = [];
function fakeServer() {
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = String(input);
    const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
    if (url.endsWith("/api/client/v1/account")) return ok({ account: accountJson() });
    const path = url.replace(`${API_ORIGIN}/api/client/v1/finance`, "");
    webRequests.push(`${who.email} ${path}`);
    if (path === "") return ok({ currency: "USD", version: `${who.email}-v1`, statement_count: 1, transaction_count: 1 });
    if (path === "/statements") return ok({ statements: [{ id: who.email.startsWith("bob") ? 900 : 800, filename: `${who.email}-web.csv`, currency: "USD", sha256: who.email, transaction_count: 1, closing_balance: null, closing_balance_on: null, imported_at: "2026-02-01T00:00:00Z" }] });
    if (path.startsWith("/transactions")) return ok({ transactions: [{ id: who.email.startsWith("bob") ? 901 : 801, statement_id: who.email.startsWith("bob") ? 900 : 800, booked_on: "2026-02-02", description: `${who.email.split("@")[0].toUpperCase()} WEB ROW`, amount: "-1.0", category: "Shopping", tax_review: false, excluded: false }], next_after_id: null });
    if (path === "/rules") return ok({ rules: [] });
    if (path === "/categories") return ok({ categories: [] });
    return new Response("{}", { status: 404 });
  });
}

const { default: App } = await import("../src/App");

async function signInAs(account: typeof who) {
  who = account;
  cleanup();
  sessionStorage.setItem("billie.token", "tok");
  localStorage.removeItem("billie.account");
  render(<App />);
}

async function rowsIn(file: string): Promise<string[]> {
  const driver = files.get(file);
  return driver ? (await driver.select<{ description: string }>("SELECT description FROM transactions ORDER BY id")).map((row) => row.description) : [];
}
async function ownerOf(file: string): Promise<string | null> {
  const [row] = await files.get(file)!.select<{ value: string }>("SELECT value FROM settings WHERE key = 'owner_account_id'");
  return row?.value ?? null;
}

beforeEach(() => { localStorage.clear(); sessionStorage.clear(); files.clear(); webRequests.length = 0; (globalThis as { __boundOwner?: string | null }).__boundOwner = null; (globalThis as { __legacy?: boolean }).__legacy = true; fakeServer(); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

it("the first account explicitly claims the pre-owner database; a second account gets its own and never sees, downloads into or changes the first", async () => {
  await signInAs({ email: "alice@example.com", owner_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" });
  await screen.findByRole("heading", { name: "Is this database yours?" });
  expect(await ownerOf("billieweather.db")).toBeNull();
  expect(webRequests).toEqual([]);
  await act(async () => screen.getByRole("button", { name: "Yes, it's mine" }).click());
  await screen.findByRole("navigation");
  await waitFor(async () => expect(await rowsIn("billieweather.db")).toContain("ALICE WEB ROW"));
  expect(await ownerOf("billieweather.db")).toBe("id:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");

  // Bob signs in on the same device.
  await act(async () => { await signInAs({ email: "bob@example.com", owner_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" }); });
  await screen.findByRole("heading", { name: "Name this device's database" });
  // Bob's database is a different file; Alice's file is untouched and still hers.
  expect(await rowsIn("billieweather.db")).toEqual(["ALICE PRIVATE ROW", "ALICE WEB ROW"]);
  expect(await ownerOf("billieweather.db")).toBe("id:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
  expect(await ownerOf("billieweather-2.db")).toBe("id:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb");
  expect(screen.queryByText(/ALICE/)).toBeNull();
  // No request for Bob ever wrote into Alice's file.
  expect(webRequests.filter((request) => request.startsWith("bob")).length).toBe(0); // Bob has not named his database yet: nothing downloaded

  // Alice comes back: her database, never Bob's.
  await act(async () => { await signInAs({ email: "alice@example.com", owner_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" }); });
  await screen.findByRole("navigation");
  expect(await rowsIn("billieweather.db")).toEqual(["ALICE PRIVATE ROW", "ALICE WEB ROW"]);
  expect(await rowsIn("billieweather-2.db")).toEqual([]);
});

it("an unowned database with data outside this account's list is only used after the person says it is theirs", async () => {
  // Carol already has her own list (she signed in after the upgrade); slot 1 holds pre-owner data she never had.
  localStorage.setItem("billie.databases.adoptedBy", "id:cccccccc-cccc-4ccc-8ccc-cccccccccccc");
  localStorage.setItem("billie.databases:id:cccccccc-cccc-4ccc-8ccc-cccccccccccc", JSON.stringify({ ids: [3], active: 3 }));
  await signInAs({ email: "dave@example.com", owner_id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd" });
  await screen.findByRole("heading", { name: "Is this database yours?" });
  await act(async () => screen.getByRole("button", { name: "No, leave it alone" }).click());
  await screen.findByRole("heading", { name: "Name this device's database" });
  expect(await ownerOf("billieweather.db")).toBeNull(); // left untouched
  expect(await rowsIn("billieweather.db")).toEqual(["ALICE PRIVATE ROW"]);
  expect(await ownerOf("billieweather-2.db")).toBe("id:dddddddd-dddd-4ddd-8ddd-dddddddddddd");
});

it("an older server without owner ids binds by the email hash and upgrades to the id later", async () => {
  await signInAs({ email: "erin@example.com", owner_id: null as unknown as string });
  await screen.findByRole("heading", { name: "Is this database yours?" });
  await act(async () => screen.getByRole("button", { name: "Yes, it's mine" }).click());
  await screen.findByRole("navigation");
  expect(await ownerOf("billieweather.db")).toMatch(/^email:[0-9a-f]{64}$/);
  await act(async () => { await signInAs({ email: "erin@example.com", owner_id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee" }); });
  await screen.findByRole("heading", { name: "Is this database yours?" });
  await act(async () => screen.getByRole("button", { name: "Yes, it's mine" }).click());
  await screen.findByRole("navigation");
  await waitFor(async () => expect(await ownerOf("billieweather.db")).toBe("id:eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee"));
  expect(await rowsIn("billieweather.db")).toContain("ALICE PRIVATE ROW");
});

it("does not use a saved token for cloud access until its cached account has been verified", async () => {
  (globalThis as { __boundOwner?: string }).__boundOwner = "id:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  who = { email: "bob@example.com", owner_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" };
  sessionStorage.setItem("billie.token", "bob-token");
  localStorage.setItem("billie.account", JSON.stringify({ email: "alice@example.com", ownerId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", locale: "en" }));
  let verify!: (response: Response) => void;
  const pending = new Promise<Response>((resolve) => { verify = resolve; });
  const original = vi.mocked(fetch).getMockImplementation()!;
  vi.mocked(fetch).mockImplementation((input, init) => String(input).endsWith("/api/client/v1/account") ? pending : original(input, init));
  render(<App />);
  await screen.findByRole("navigation");
  await waitFor(async () => expect(await ownerOf("billieweather.db")).toBe("id:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"));
  await act(async () => { await Promise.resolve(); });
  expect(webRequests).toEqual([]);
  await act(async () => { verify(new Response(JSON.stringify({ account: accountJson() }), { status: 200 })); });
  await screen.findByRole("heading", { name: "Name this device's database" });
  expect(await rowsIn("billieweather.db")).toEqual(["ALICE PRIVATE ROW"]);
});
