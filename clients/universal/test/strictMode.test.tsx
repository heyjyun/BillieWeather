// @vitest-environment jsdom
// Regression: React StrictMode mounts effects twice; the app must end up with ONE local
// database that both the website download and every page use.
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { StrictMode } from "react";
import initSqlJs from "sql.js";
import { migrate } from "./helpers";
import { sqljsDriver } from "../src/services/sqljsDriver";
import { API_ORIGIN } from "../src/services/account";

let opened = 0;
vi.mock("../src/services/platform", () => ({
  isTauri: () => false,
  openDatabase: async () => {
    opened += 1;
    const SQL = await initSqlJs();
    const db = new SQL.Database(); // a fresh in-memory database per call, like the browser preview
    migrate(db);
    return { driver: sqljsDriver(db), persistent: false };
  },
  deviceName: async () => null,
  deviceIdentity: async (candidate: string) => ({ deviceId: candidate, platform: "macos", reportable: true }),
  saveFile: async () => true,
}));
const account = { email: "jyun@example.com", nickname: "jyun", locale: "en", timeZone: null, usageRegion: "US", registeredAt: "2026-11-01T12:00:00Z", badges: [] };
vi.mock("../src/services/account", async (importOriginal) => ({ ...(await importOriginal<typeof import("../src/services/account")>()), fetchAccount: vi.fn(async () => account) }));
const { default: App } = await import("../src/App");

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

it("downloads into the same database the Data page reads", async () => {
  sessionStorage.setItem("billie.token", "tok");
  localStorage.setItem("billie.account", JSON.stringify(account));
  localStorage.setItem("billie.locale", "en");
  const ok = (b: unknown) => new Response(JSON.stringify(b), { status: 200 });
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const path = String(input).replace(`${API_ORIGIN}/api/client/v1/finance`, "");
    if (path === "") return ok({ currency: "USD", version: "v1", statement_count: 1, transaction_count: 1, storage_bytes: 100 });
    if (path === "/statements") return ok({ statements: [{ id: 1, filename: "web.csv", currency: "USD", sha256: "w", transaction_count: 1, closing_balance: null, closing_balance_on: null, imported_at: "2026-01-01T00:00:00Z", period_start: "2026-01-05", period_end: "2026-01-05" }] });
    if (path === "/rules") return ok({ rules: [] });
    return ok({ transactions: [{ id: 9, statement_id: 1, booked_on: "2026-01-05", description: "WEB", amount: "-1.0", category: "Shopping", tax_review: false, excluded: false }], next_after_id: null });
  });
  render(<StrictMode><App /></StrictMode>);
  await screen.findByText(/Downloaded from your website account/);
  fireEvent.click(within(screen.getByRole("navigation")).getByRole("button", { name: "Data" }));
  const device = (await screen.findByRole("heading", { name: "Unnamed database" })).closest("section")! as HTMLElement;
  await waitFor(() => expect(within(device).getByText("Statements").nextElementSibling!.textContent).toBe("1"));
  expect(within(device).getByText("Dates").nextElementSibling!.textContent).toBe("2026-01-05");
  expect(opened).toBeGreaterThanOrEqual(1);
});
