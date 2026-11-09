// @vitest-environment jsdom
// The complete workflow through the real UI: sign in → website data downloads automatically →
// import a local statement → dashboard → correct a category (remembered) → export CSV and Excel →
// switch language → delete local data → sign out.
// The account API is mocked and a fake server answers the read-only website-data download.
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import initSqlJs from "sql.js";
import { fixtureBytes, migrate } from "./helpers";
import { sqljsDriver } from "../src/services/sqljsDriver";
import { unzipStored } from "@billie/reporting";
import { REPORT_FIELDS } from "../src/services/localReport";
import { API_ORIGIN } from "../src/services/account";

const saved: Array<{ filename: string; bytes: Uint8Array }> = [];
vi.mock("../src/services/platform", () => ({
  isTauri: () => false,
  openDatabase: async () => {
    const SQL = await initSqlJs();
    const db = new SQL.Database();
    migrate(db);
    return { driver: sqljsDriver(db), persistent: true };
  },
  deviceName: async () => "Jyun's MacBook Pro",
  saveFile: async (filename: string, bytes: Uint8Array) => {
    saved.push({ filename, bytes });
    return true;
  },
}));

const account = { email: "jyun@example.com", nickname: "jyun", locale: null as string | null, timeZone: null, usageRegion: "US", registeredAt: "2026-11-01T12:00:00Z", badges: ["member"] };
const api = vi.hoisted(() => ({ calls: [] as Array<[string, unknown]> }));
vi.mock("../src/services/account", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/services/account")>();
  return {
    ...real,
    signIn: vi.fn(async (email: string, password: string) => {
      api.calls.push(["signIn", { email, password }]);
      if (password !== "right-password") throw new real.AccountError("invalid_credentials");
      return { token: "tok", expiresAt: "2026-12-09T00:00:00Z", account };
    }),
    fetchAccount: vi.fn(async () => account),
    updateAccount: vi.fn(async (_token: string, preferences: Record<string, unknown>) => {
      api.calls.push(["updateAccount", preferences]);
      return { ...account, ...(preferences.locale ? { locale: preferences.locale as string } : {}) };
    }),
    signOutRemote: vi.fn(async () => undefined),
  };
});

const { default: App } = await import("../src/App");

function upload(input: HTMLInputElement, name: string, bytes: Uint8Array) {
  const file = new File([bytes as BlobPart], name, { type: "text/csv" });
  Object.defineProperty(file, "arrayBuffer", { value: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) });
  fireEvent.change(input, { target: { files: [file] } });
}

const nav = (label: string) => fireEvent.click(within(screen.getByRole("navigation")).getByRole("button", { name: label }));

beforeEach(() => { localStorage.clear(); sessionStorage.clear(); localStorage.setItem("billie.locale", "en"); });
afterEach(cleanup);

it("signs in, works with local data, switches language, and signs out", async () => {
  // Fake BillieWeather server: the person already has one statement on the website.
  const requests: Array<{ url: string; init: RequestInit }> = [];
  const respond = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = String(input);
    requests.push({ url, init: init ?? {} });
    const path = url.replace(`${API_ORIGIN}/api/client/v1/finance`, "");
    if (path === "") return respond({ currency: "USD", version: "web-v1", statement_count: 1, transaction_count: 2 });
    if (path === "/statements") return respond({ statements: [{ id: 501, filename: "web-checking.csv", currency: "USD", sha256: "f".repeat(64), transaction_count: 2, closing_balance: null, closing_balance_on: null, imported_at: "2026-03-01T00:00:00Z" }] });
    if (path === "/rules") return respond({ rules: [] });
    if (path.startsWith("/transactions")) {
      return respond({ transactions: [
        { id: 9001, statement_id: 501, booked_on: "2026-03-01", description: "WEB SIDE GIG", amount: "1000.0", category: "Income", tax_review: false, excluded: false },
        { id: 9002, statement_id: 501, booked_on: "2026-03-02", description: "WEB COFFEE BAR", amount: "-4.5", category: "Food & dining", tax_review: false, excluded: false },
      ], next_after_id: null });
    }
    return new Response("{}", { status: 404 });
  });
  render(<App />);

  // Sign-in screen first.
  await screen.findByRole("heading", { name: "Sign in to BillieWeather" });
  fireEvent.change(screen.getByLabelText("Email"), { target: { value: "jyun@example.com" } });
  fireEvent.change(screen.getByLabelText("Password"), { target: { value: "wrong" } });
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Sign in" })));
  await screen.findByText("That email and password don't match.");
  fireEvent.change(screen.getByLabelText("Password"), { target: { value: "right-password" } });
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Sign in" })));
  // First time on this device: name its database. The device's own name is filled in,
  // and nothing is downloaded until the database has a name.
  await screen.findByRole("heading", { name: "Name this device's database" });
  const nameField = screen.getByLabelText("Database name") as HTMLInputElement;
  await waitFor(() => expect(nameField.value).toBe("Jyun's MacBook Pro"));
  expect(requests.some((request) => request.url.includes("/finance"))).toBe(false);
  fireEvent.change(nameField, { target: { value: "  Jyun's   laptop " } });
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Create database" })));
  // Website data is downloaded right after signing in.
  await screen.findByText("Downloaded from your website account: 1 new statement(s), 2 new and 0 updated transaction(s), 0 removed.");
  // The account had no language yet, so the one chosen on this device is saved to it.
  await waitFor(() => expect(api.calls).toContainEqual(["updateAccount", { locale: "en" }]));
  expect(sessionStorage.getItem("billie.token")).toBe("tok");

  nav("Import");
  const input = document.querySelector<HTMLInputElement>('input[type="file"]')!;
  await act(async () => upload(input, "basic-amount.csv", fixtureBytes("basic-amount.csv")));
  await screen.findByText(/basic-amount\.csv: 9 transactions imported, closing balance \$3,448\.65\./);
  expect(screen.getByText("web-checking.csv").parentElement!.textContent).toContain("From website");
  await act(async () => upload(input, "basic-amount.csv", fixtureBytes("basic-amount.csv")));
  await screen.findByText(/basic-amount\.csv: This statement has already been imported|basic-amount\.csv: .*already/i);

  nav("Dashboard");
  await screen.findByText("Monthly cash flow");
  expect(screen.getByText("$6,000.00")).toBeTruthy(); // 2 payrolls from the local file + 1,000 from the website

  nav("Transactions");
  const select = await screen.findByLabelText("Category for AMAZON WEB SERVICES AWS.AMAZON.CO");
  await act(async () => fireEvent.change(select, { target: { value: "Business" } }));
  await screen.findByText(/"amazon services" will be Business from now on/);

  nav("Reports");
  await act(async () => fireEvent.click(await screen.findByRole("button", { name: "Export CSV" })));
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Export Excel" })));
  await waitFor(() => expect(saved.length).toBe(2));
  expect(new TextDecoder().decode(saved[0].bytes)).toContain("AMAZON WEB SERVICES AWS.AMAZON.CO,Business,-61.2,USD,true,false,true");
  expect(unzipStored(saved[1].bytes).has("xl/worksheets/sheet3.xml")).toBe(true);

  // Switch to Simplified Chinese: the whole UI follows and the choice is saved to the account.
  nav("Settings");
  expect(await screen.findByText("jyun@example.com", { selector: "dd" })).toBeTruthy();
  await act(async () => fireEvent.change(screen.getByLabelText("Language"), { target: { value: "zh-CN" } }));
  await waitFor(() => expect(api.calls).toContainEqual(["updateAccount", { locale: "zh-CN" }]));
  expect(await screen.findByRole("heading", { name: "设置与隐私" })).toBeTruthy();
  expect(within(screen.getByRole("navigation")).getByRole("button", { name: "财务总览" })).toBeTruthy();

  // Excel follows the language too.
  nav("报表");
  await act(async () => fireEvent.click(await screen.findByRole("button", { name: "导出 Excel" })));
  await waitFor(() => expect(saved.length).toBe(3));
  const workbook = new TextDecoder().decode(unzipStored(saved[2].bytes).get("xl/workbook.xml")!);
  expect(workbook).toContain('name="概览"');

  // Delete local financial data (account untouched).
  // Manage data one statement at a time (no "delete everything" button anywhere).
  nav("数据管理");
  const row = (await screen.findAllByText("basic-amount.csv"))[0].closest("li")! as HTMLElement;
  fireEvent.click(within(row).getByRole("button", { name: "从本机移除" }));
  expect(within(row).getByText(/只存在于这台设备上/)).toBeTruthy();
  await act(async () => fireEvent.click(within(row).getByRole("button", { name: "移除" })));
  await screen.findByText("已从本机移除「basic-amount.csv」。");
  nav("设置");

  // Sign out → back to the sign-in screen, token gone.
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "退出登录" })));
  await screen.findByRole("heading", { name: "登录 BillieWeather" });
  expect(sessionStorage.getItem("billie.token")).toBeNull();

  // No financial data was uploaded: the account API never saw any, the website-data download
  // was read-only GETs, and the only other requests were the automatic metadata reports
  // (names, sizes, counts) for the website's "Local databases" cards.
  expect(JSON.stringify(api.calls)).not.toMatch(/AMAZON|HYPERLINK|basic-amount|amount/i);
  expect(requests.length).toBeGreaterThan(0);
  const finance = requests.filter(({ url }) => url.startsWith(`${API_ORIGIN}/api/client/v1/finance`));
  const metadata = requests.filter(({ url }) => url.startsWith(`${API_ORIGIN}/api/client/v1/devices/`));
  expect(finance.length + metadata.length).toBe(requests.length);
  for (const { init } of finance) {
    expect(init.method).toBe("GET");
    expect(init.body).toBeUndefined();
  }
  for (const { init } of metadata) {
    expect(["PUT", "DELETE"]).toContain(init.method);
    expect(String(init.body ?? "")).not.toMatch(/AMAZON|HYPERLINK|basic-amount|description|amount"/i);
    if (init.body) expect(Object.keys(JSON.parse(String(init.body)).database)).toEqual([...REPORT_FIELDS]);
  }
});
