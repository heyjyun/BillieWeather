// @vitest-environment jsdom
// When the local SQLite database cannot be OPENED (the SQL plugin rejects Database.load), the app
// must say so with the real reason. It must not report "no free database", must not drop the
// database from the account's list, and must not start an empty database in its place. After the
// cause goes away (the next launch), the same database opens with its data. Synthetic data only.
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import initSqlJs from "sql.js";
import { migrate } from "./helpers";
import { sqljsDriver } from "../src/services/sqljsDriver";
import { openFailure } from "../src/services/databases";
import { FinanceProvider, useFinance } from "../src/hooks/useFinance";
import { I18nProvider, MESSAGES } from "../src/i18n";

const files = new Map<string, ReturnType<typeof sqljsDriver>>();
const opened: string[] = [];
let failing: (file: string) => string | null = () => null;
vi.mock("../src/hooks/useAccount", () => {
  const getToken = () => null;
  const expire = async () => undefined;
  return { useAccount: () => ({ account: null, getToken, expire }) };
});
vi.mock("../src/services/platform", async () => {
  const SQL = await initSqlJs();
  return {
    isTauri: () => false,
    deviceName: async () => "Synthetic Mac",
    deviceIdentity: async () => null,
    openDatabase: async (file: string) => {
      opened.push(file);
      const reason = failing(file);
      // The plugin rejects with SQLite's message as a plain string, not an Error.
      if (reason) throw reason;
      if (!files.has(file)) {
        const db = new SQL.Database();
        migrate(db);
        files.set(file, sqljsDriver(db));
      }
      return { driver: files.get(file)!, persistent: true };
    },
  };
});

const en = MESSAGES.en;
const LIST = "billie.databases:id:bob";

async function seedBobsBook() {
  const db = new (await initSqlJs()).Database();
  migrate(db);
  db.run("INSERT INTO statements (filename, currency, sha256, transaction_count, imported_at) VALUES ('bob.csv','USD','b',1,'2026-01-01')");
  db.run("INSERT INTO transactions (statement_id, booked_on, description, amount_cents, category, updated_at, kind) VALUES (1,'2026-01-02','SYNTHETIC ROW',-500,'Shopping','x','expense')");
  db.run("INSERT INTO settings (key, value) VALUES ('currency','USD'), ('database_name','Bob Mac'), ('owner_account_id','id:bob')");
  files.set("billieweather.db", sqljsDriver(db));
  localStorage.setItem(LIST, JSON.stringify({ ids: [1], active: 1 }));
}

function Probe() {
  const finance = useFinance();
  return <p>Ready {finance.activeDatabaseId} {finance.transactions.length}</p>;
}
const mount = () => render(<I18nProvider initial="en"><FinanceProvider ownerKey="id:bob" emailKey="email:bob"><Probe /></FinanceProvider></I18nProvider>);

beforeEach(() => { localStorage.clear(); files.clear(); opened.length = 0; failing = () => null; });
afterEach(() => cleanup());

it("reports the real open error, not 'no free database', when no slot can be opened", async () => {
  failing = () => "error returned from database: (code: 14) unable to open database file";
  mount();
  const alert = await screen.findByRole("alert");
  expect(alert.textContent).toContain(en.boot.dbError);
  expect(alert.textContent).toContain("unable to open database file");
  expect(screen.queryByText(en.ledger.owner.noRoom)).toBeNull();
});

it("keeps the account's own database listed and does not start an empty one when it fails to open", async () => {
  await seedBobsBook();
  failing = (file) => (file === "billieweather.db" ? "database is locked" : null);
  mount();
  expect((await screen.findByRole("alert")).textContent).toContain("database is locked");
  expect(JSON.parse(localStorage.getItem(LIST)!).ids).toEqual([1]);
  expect(opened.every((file) => file === "billieweather.db")).toBe(true); // no billieweather-2.db … -8.db
  expect(files.has("billieweather-2.db")).toBe(false);
});

it("opens the same database with its data on the next launch once the cause is gone", async () => {
  await seedBobsBook();
  failing = () => "database is locked";
  const first = mount();
  await screen.findByRole("alert");
  first.unmount();

  failing = () => null; // e.g. the app was restarted
  mount();
  expect(await screen.findByText("Ready 1 1")).toBeTruthy();
  expect(JSON.parse(localStorage.getItem(LIST)!).ids).toEqual([1]);
  const [owner] = await files.get("billieweather.db")!.select<{ value: string }>("SELECT value FROM settings WHERE key = 'owner_account_id'");
  expect(owner.value).toBe("id:bob");
});

it("still creates a new database for an account with none (nothing failing)", async () => {
  mount();
  await screen.findByRole("heading", { name: en.dbName.heading });
  const [owner] = await files.get("billieweather.db")!.select<{ value: string }>("SELECT value FROM settings WHERE key = 'owner_account_id'");
  expect(owner.value).toBe("id:bob");
});

async function seedTwoBooks() {
  await seedBobsBook();
  const db = new (await initSqlJs()).Database();
  migrate(db);
  db.run("INSERT INTO settings (key, value) VALUES ('currency','USD'), ('database_name','Second'), ('owner_account_id','id:bob')");
  files.set("billieweather-2.db", sqljsDriver(db));
  localStorage.setItem(LIST, JSON.stringify({ ids: [1, 2], active: 1 }));
}
const press = (name: string) => act(async () => { fireEvent.click(screen.getByRole("button", { name })); });

it("never opens another database in place of the one in use without being asked", async () => {
  await seedTwoBooks();
  failing = (file) => (file === "billieweather.db" ? "error returned from database: (code: 26) file is not a database" : null);
  mount();
  const alert = await screen.findByRole("alert");
  expect(alert.textContent).toContain(en.boot.failure.damaged);
  expect(opened).not.toContain("billieweather-2.db");
  expect(JSON.parse(localStorage.getItem(LIST)!)).toEqual({ ids: [1, 2], active: 1 });

  await press(en.boot.openAnother);
  expect(await screen.findByText("Ready 2 0")).toBeTruthy();
  expect(JSON.parse(localStorage.getItem(LIST)!).ids).toEqual([1, 2]); // the damaged one stays listed
  expect(opened.some((file) => /-[3-8]\.db$/.test(file))).toBe(false); // and no empty one was started
});

it("Try again opens the same database once the cause is gone", async () => {
  await seedTwoBooks();
  failing = () => "database is locked";
  mount();
  expect((await screen.findByRole("alert")).textContent).toContain(en.boot.failure.locked);
  failing = () => null;
  await press(en.connection.retry);
  expect(await screen.findByText("Ready 1 1")).toBeTruthy();
});

it("offers no other database when there is none", async () => {
  await seedBobsBook();
  failing = () => "database is locked";
  mount();
  await screen.findByRole("alert");
  expect(screen.queryByRole("button", { name: en.boot.openAnother })).toBeNull();
});

it.each([
  ["error returned from database: (code: 5) database is locked", "locked"],
  ["error returned from database: (code: 26) file is not a database", "damaged"],
  ["error returned from database: (code: 11) database disk image is malformed", "damaged"],
  ["migration 10 was previously applied but is missing in the resolved migrations", "newer"],
  ["migration 7 was previously applied but has been modified", "incomplete"],
  ["the local database schema is incomplete (version 9, 9 of 10 migrations)", "incomplete"],
  ["error returned from database: (code: 13) database or disk is full", "full"],
  ["error returned from database: (code: 14) unable to open database file", "permission"],
  ["error returned from database: (code: 8) attempt to write a readonly database", "permission"],
  ["something else", "other"],
])("explains %s", (reason, kind) => expect(openFailure(reason)).toBe(kind));

it("a change that was saved is never reported as failed because the book could not be read back", async () => {
  await seedBobsBook();
  let outcome = "";
  function Saver() {
    const { store, refresh } = useFinance();
    return <button onClick={() => { void store.setExcluded(1, true).then(refresh).then(() => { outcome = "saved"; }, () => { outcome = "failed"; }); }}>save</button>;
  }
  render(<I18nProvider initial="en"><FinanceProvider ownerKey="id:bob" emailKey="email:bob"><Probe /><Saver /></FinanceProvider></I18nProvider>);
  await screen.findByText("Ready 1 1");
  const driver = files.get("billieweather.db")!;
  const select = driver.select;
  const transaction = driver.transaction;
  driver.transaction = async (statements) => { const result = await transaction(statements); driver.select = async () => { throw "database is locked"; }; return result; };
  await press("save");
  expect((await screen.findByRole("alert")).textContent).toContain(en.boot.failure.locked);
  expect(outcome).toBe("saved");
  driver.select = select;
  driver.transaction = transaction;
  await press(en.connection.retry);
  expect(await screen.findByText("Ready 1 1")).toBeTruthy();
  expect((await select<{ excluded: number }>("SELECT excluded FROM transactions WHERE id = 1"))[0].excluded).toBe(1);
});
