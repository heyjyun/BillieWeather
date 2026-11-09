// @vitest-environment jsdom
// The complete workflow through the real UI: sign in → import → dashboard → correct a
// category (remembered) → export CSV and Excel → switch language → delete local data → sign out.
// The account API is mocked; financial data never goes to it.
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import initSqlJs from "sql.js";
import { fixtureBytes, migrate } from "./helpers";
import { sqljsDriver } from "../src/services/sqljsDriver";
import { unzipStored } from "@billie/reporting";

const saved: Array<{ filename: string; bytes: Uint8Array }> = [];
vi.mock("../src/services/platform", () => ({
  isTauri: () => false,
  openDatabase: async () => {
    const SQL = await initSqlJs();
    const db = new SQL.Database();
    migrate(db);
    return { driver: sqljsDriver(db), persistent: true };
  },
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
  const fetchSpy = vi.spyOn(globalThis, "fetch");
  render(<App />);

  // Sign-in screen first.
  await screen.findByRole("heading", { name: "Sign in to BillieWeather" });
  fireEvent.change(screen.getByLabelText("Email"), { target: { value: "jyun@example.com" } });
  fireEvent.change(screen.getByLabelText("Password"), { target: { value: "wrong" } });
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Sign in" })));
  await screen.findByText("That email and password don't match.");
  fireEvent.change(screen.getByLabelText("Password"), { target: { value: "right-password" } });
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Sign in" })));
  await screen.findByText("No statements yet");
  // The account had no language yet, so the one chosen on this device is saved to it.
  await waitFor(() => expect(api.calls).toContainEqual(["updateAccount", { locale: "en" }]));
  expect(sessionStorage.getItem("billie.token")).toBe("tok");

  nav("Import");
  const input = document.querySelector<HTMLInputElement>('input[type="file"]')!;
  await act(async () => upload(input, "basic-amount.csv", fixtureBytes("basic-amount.csv")));
  await screen.findByText(/basic-amount\.csv: 9 transactions imported, closing balance \$3,448\.65\./);
  await act(async () => upload(input, "basic-amount.csv", fixtureBytes("basic-amount.csv")));
  await screen.findByText(/basic-amount\.csv: This statement has already been imported|basic-amount\.csv: .*already/i);

  nav("Dashboard");
  await screen.findByText("Monthly cash flow");
  expect(screen.getByText("$5,000.00")).toBeTruthy();

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
  nav("设置");
  fireEvent.change(await screen.findByLabelText("输入 DELETE 确认"), { target: { value: "DELETE" } });
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "删除全部本地数据" })));
  await screen.findByText("这台设备上的所有本地财务数据已删除。");

  // Sign out → back to the sign-in screen, token gone.
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "退出登录" })));
  await screen.findByRole("heading", { name: "登录 BillieWeather" });
  expect(sessionStorage.getItem("billie.token")).toBeNull();

  // Financial data never went to the account API, and nothing else used the network.
  expect(JSON.stringify(api.calls)).not.toMatch(/AMAZON|HYPERLINK|basic-amount|amount/i);
  expect(fetchSpy).not.toHaveBeenCalled();
});
