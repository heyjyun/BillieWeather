// @vitest-environment jsdom
// Registering a new account on a device that already holds another account's financial data:
// the whole app, with the identity service and the Rails account API faked at the fetch boundary.
// The new account never sees, rebinds or uploads the previous account's local database, and the
// registration requests carry no financial data. Synthetic data only.
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import initSqlJs from "sql.js";
import { migrate } from "./helpers";
import { sqljsDriver } from "../src/services/sqljsDriver";
import { API_ORIGIN } from "../src/services/account";
import { IDENTITY_ORIGIN } from "../src/services/registration";
import { MESSAGES } from "../src/i18n";

const files = new Map<string, ReturnType<typeof sqljsDriver>>();
vi.mock("../src/services/platform", async () => {
  const SQL = await initSqlJs();
  return {
    isTauri: () => false,
    openDatabase: async (file = "billieweather.db") => {
      if (!files.has(file)) {
        const db = new SQL.Database();
        migrate(db);
        if (file === "billieweather.db") {
          // Alice's local book, bound to Alice's account.
          db.run("INSERT INTO statements (filename, currency, sha256, transaction_count, imported_at) VALUES ('alice.csv','USD','a',1,'2026-01-01')");
          db.run("INSERT INTO transactions (statement_id, booked_on, description, amount_cents, category, updated_at, kind) VALUES (1,'2026-01-02','ALICE PRIVATE ROW',-500,'Shopping','x','expense')");
          db.run("INSERT INTO settings (key, value) VALUES ('currency','USD'), ('database_name','Alice Mac'), ('owner_account_id','id:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')");
        }
        files.set(file, sqljsDriver(db));
      }
      return { driver: files.get(file)!, persistent: true };
    },
    deviceName: async () => "Shared Mac",
    deviceIdentity: async () => null,
    saveFile: async () => true,
  };
});

const BOB = { email: "bob@example.org", nickname: "Bob", locale: "en", time_zone: null, usage_region: "XG", registered_at: new Date().toISOString(), badges: ["member"], owner_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" };
const identityBodies: string[] = [];
const railsRequests: string[] = [];

function fakeServers() {
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
    if (url.origin === IDENTITY_ORIGIN) {
      identityBodies.push(String(init?.body ?? ""));
      if (url.pathname === "/v1/config") return json(200, { registration_open: true, google_available: false, password: { min: 6, max: 128 } });
      if (url.pathname === "/v1/registrations") return json(202, { registration_id: "11111111-1111-4111-8111-111111111111", registration_secret: "sec", email: "bob@example.org", code_length: 8, code_expires_at: "x", resend_available_at: "y" });
      if (url.pathname.endsWith("/confirmation")) return json(201, { status: "confirmed", email: "bob@example.org" });
      return json(404, { error: "not_found" });
    }
    expect(url.origin).toBe(API_ORIGIN);
    railsRequests.push(`${method} ${url.pathname}`);
    if (url.pathname === "/api/client/v1/session" && method === "POST") {
      expect(JSON.parse(String(init?.body))).toEqual({ email: "bob@example.org", password: "bob's passphrase" });
      return json(201, { token: "bob-token", expires_at: "2026-12-17T00:00:00Z", account: BOB });
    }
    if (url.pathname === "/api/client/v1/account") return json(200, { account: BOB });
    return json(404, {});
  });
}

async function rowsIn(file: string): Promise<string[]> {
  const driver = files.get(file);
  return driver ? (await driver.select<{ description: string }>("SELECT description FROM transactions ORDER BY id")).map((row) => row.description) : [];
}
async function ownerOf(file: string): Promise<string | null> {
  const [row] = await files.get(file)!.select<{ value: string }>("SELECT value FROM settings WHERE key = 'owner_account_id'");
  return row?.value ?? null;
}

const { default: App } = await import("../src/App");
const en = MESSAGES.en;

beforeEach(() => { localStorage.clear(); sessionStorage.clear(); files.clear(); identityBodies.length = 0; railsRequests.length = 0; fakeServers(); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

it("a new account registered after signing out gets its own database and never sees or changes the previous account's", async () => {
  // Alice's database exists on this device; nobody is signed in.
  await (await import("../src/services/platform")).openDatabase("billieweather.db");
  localStorage.setItem("billie.locale", "en");
  render(<App />);
  fireEvent.click(await screen.findByRole("button", { name: en.login.createAccount }));
  await screen.findByRole("heading", { name: en.register.heading });

  fireEvent.change(screen.getByLabelText(/^Nickname/), { target: { value: "Bob" } }); // required for every new account
  fireEvent.change(screen.getByLabelText(en.register.email), { target: { value: "bob@example.org" } });
  fireEvent.change(screen.getByLabelText(en.register.password), { target: { value: "bob's passphrase" } });
  fireEvent.change(screen.getByLabelText(en.register.confirmPassword), { target: { value: "bob's passphrase" } });
  fireEvent.click(screen.getByRole("button", { name: en.register.submit }));
  await screen.findByRole("heading", { name: en.register.verify.heading });
  // Registration sends nothing from the local database, and touches no financial endpoint.
  expect(railsRequests).toEqual([]);
  fireEvent.change(screen.getByLabelText(en.register.verify.code), { target: { value: "12345678" } });
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: en.register.verify.submit })); });

  // Signed in through the existing account flow, as a NEW owner: Bob names his own database.
  await screen.findByRole("heading", { name: en.dbName.heading });
  expect(railsRequests[0]).toBe("POST /api/client/v1/session");
  expect(await rowsIn("billieweather.db")).toEqual(["ALICE PRIVATE ROW"]);
  expect(await ownerOf("billieweather.db")).toBe("id:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"); // not rebound
  await waitFor(async () => expect(await ownerOf("billieweather-2.db")).toBe("id:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"));
  expect(await rowsIn("billieweather-2.db")).toEqual([]);
  expect(screen.queryByText(/ALICE/)).toBeNull();
  expect(railsRequests.filter((request) => request.includes("/finance") || request.includes("/devices"))).toEqual([]);

  fireEvent.change(screen.getByLabelText(en.dbName.label), { target: { value: "Bob device" } });
  fireEvent.click(screen.getByRole("button", { name: en.dbName.create }));
  const navigation = await screen.findByRole("navigation", { name: en.nav.main });
  expect([...navigation.querySelectorAll("#module-nav button")].map((item) => item.textContent)).toEqual(["Financial Overview", "AI Insight"]);
  expect(navigation.querySelector('#module-nav [aria-current="page"]')?.textContent).toBe("Financial Overview");
  expect(navigation.querySelector(".bw-nav-bottom > .bw-system-nav + .bw-nav-user")).toBeTruthy();
  expect(navigation.querySelector(".bw-system-nav button")?.textContent).toBe("Settings");
  expect(await rowsIn("billieweather-2.db")).toEqual([]);

  // The identity service received sign-up details only.
  const sent = identityBodies.join("\n");
  expect(sent).not.toMatch(/ALICE|alice\.csv|Alice Mac|amount|transaction|statement/i);
  expect(JSON.stringify({ ...localStorage, ...sessionStorage })).not.toMatch(/bob's passphrase|"sec"/);
});
