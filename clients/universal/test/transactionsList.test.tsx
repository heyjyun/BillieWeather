// @vitest-environment jsdom
// A long ledger opens quickly: rows are added in steps, while counts, search and "select all" cover everything.
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import initSqlJs from "sql.js";
import { migrate, openInShell, enableAllModulesByDefault } from "./helpers";
import { sqljsDriver } from "../src/services/sqljsDriver";

const ROWS = Number(process.env.BENCH_ROWS ?? 450);
const files = new Map<string, ReturnType<typeof sqljsDriver>>();
vi.mock("../src/services/platform", async () => {
  const SQL = await initSqlJs();
  return {
    isTauri: () => false,
    openDatabase: async (file = "billieweather.db") => {
      if (!files.has(file)) {
        const db = new SQL.Database();
        migrate(db);
        db.run("INSERT INTO settings (key, value) VALUES ('owner_account_id', 'id:12345678-1234-4123-8123-123456789abc'), ('database_name', 'Long book'), ('currency', 'USD')");
        db.run("INSERT INTO statements (id, filename, currency, sha256, transaction_count, imported_at) VALUES (1, 'long.csv', 'USD', 'long', ?, '2026-10-01')", [ROWS]);
        for (let i = 1; i <= ROWS; i++) {
          db.run("INSERT INTO transactions (statement_id, booked_on, description, amount_cents, category, updated_at) VALUES (1, '2026-10-01', ?, -100, 'Shopping', '2026-10-01')", [`SYNTHETIC ROW ${String(i).padStart(5, "0")}`]);
        }
        files.set(file, sqljsDriver(db));
      }
      return { driver: files.get(file)!, persistent: true };
    },
    deviceName: async () => "Mac", deviceIdentity: async () => null, saveFile: async () => true, listSnapshots: async () => [],
  };
});
const { default: App } = await import("../src/App");

beforeEach(() => {
  enableAllModulesByDefault(); localStorage.clear(); sessionStorage.clear(); files.clear();
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => String(input).endsWith("/account")
    ? new Response(JSON.stringify({ account: { email: "m@example.com", nickname: null, locale: "en", time_zone: null, usage_region: "US", registered_at: null, badges: [], owner_id: "12345678-1234-4123-8123-123456789abc" } }), { status: 200 })
    : new Response(JSON.stringify({ currency: null, version: "0", statement_count: 0, transaction_count: 0, statements: [], transactions: [], next_after_id: null, rules: [], categories: [] }), { status: 200 }));
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const rows = () => document.querySelectorAll(".bw-tx-table > li").length;

it("shows a long list in steps and still searches and selects all of it", async () => {
  sessionStorage.setItem("billie.token", "tok");
  render(<App />);
  await screen.findByRole("navigation");
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Manual" })); });
  const start = performance.now();
  await openInShell("All Transactions");
  await screen.findByText(`${ROWS} of ${ROWS} transactions`, { exact: false });
  if (process.env.BENCH_ROWS) console.log(`BENCH rows=${ROWS} rendered=${rows()} nodes=${document.querySelectorAll("*").length} open=${Math.round(performance.now() - start)}ms`);
  expect(rows()).toBe(200);
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: /Show 200 more/ })); });
  expect(rows()).toBe(400);
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: /Show 50 more/ })); });
  expect(rows()).toBe(ROWS);
  expect(screen.queryByRole("button", { name: /Show .* more/ })).toBeNull();
  // Select all covers rows that are not on screen, and a search finds them.
  await act(async () => { fireEvent.click(screen.getByLabelText("Select all", { exact: false })); });
  expect(screen.getByRole("region", { name: `${ROWS} selected` })).toBeTruthy();
  await act(async () => { fireEvent.change(document.querySelector<HTMLInputElement>('input[type="search"]')!, { target: { value: "ROW 00001" } }); });
  expect(rows()).toBe(1);
}, 120_000);

it("says so when a category change or an exclusion could not be saved", async () => {
  sessionStorage.setItem("billie.token", "tok");
  render(<App />);
  await screen.findByRole("navigation");
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Manual" })); });
  await openInShell("All Transactions");
  await screen.findByText(`${ROWS} of ${ROWS} transactions`, { exact: false });
  const driver = files.get("billieweather.db")!;
  driver.transaction = async () => { throw "database is locked"; };
  const row = document.querySelector<HTMLElement>(".bw-tx-table > li")!;
  const select = [...row.querySelectorAll("select")].find((item) => [...item.options].some((option) => option.value === "Health"))!;
  await act(async () => { fireEvent.change(select, { target: { value: "Health" } }); });
  const { MESSAGES } = await import("../src/i18n");
  expect(await screen.findByText(MESSAGES.en.ledger.errors.unknown)).toBeTruthy();
  const [stored] = await driver.select<{ n: number }>("SELECT COUNT(*) AS n FROM transactions WHERE category = 'Health'");
  expect(stored.n).toBe(0);
});
