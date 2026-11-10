// @vitest-environment jsdom
// The optional Country / Region field through the real UI: defaults to Not specified, is saved
// with the statement, and can be changed later and reclassified on request. Synthetic data only.
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import initSqlJs from "sql.js";
import { migrate } from "./helpers";
import { sqljsDriver } from "../src/services/sqljsDriver";
import { API_ORIGIN } from "../src/services/account";

vi.mock("../src/services/platform", () => ({
  isTauri: () => false,
  openDatabase: async () => {
    const SQL = await initSqlJs();
    const db = new SQL.Database();
    migrate(db);
    return { driver: sqljsDriver(db), persistent: true };
  },
  deviceName: async () => "Test Mac",
  saveFile: async () => true,
}));

const account = { email: "region@example.com", nickname: null, locale: "en", timeZone: null, usageRegion: "US", registeredAt: "2026-11-01T12:00:00Z", badges: [] };
vi.mock("../src/services/account", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/services/account")>();
  return {
    ...real,
    signIn: vi.fn(async () => ({ token: "tok", expiresAt: "2026-12-09T00:00:00Z", account })),
    fetchAccount: vi.fn(async () => account),
    updateAccount: vi.fn(async () => account),
    signOutRemote: vi.fn(async () => undefined),
  };
});

vi.mock("../src/services/pdfText", () => ({
  readPdfPages: async () => ["Statement period: October 1, 2025 through October 31, 2025\n10/02 Salary ACME Ltd +2,400.00\n10/05 TESCO STORES 3021 -86.35\n10/06 FOOD COURT 12 -5.00\n"],
}));

const { default: App } = await import("../src/App");
const nav = (label: string) => fireEvent.click(within(screen.getByRole("navigation")).getByRole("button", { name: label }));

beforeEach(() => { localStorage.clear(); sessionStorage.clear(); localStorage.setItem("billie.locale", "en"); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

it("never asks for or reads the device location", () => {
  const files = (dir: string): string[] => readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : /\.(ts|tsx)$/.test(name) ? [path] : [];
  });
  const sources = [join(__dirname, "../src"), join(__dirname, "../../../packages/finance-core/src")].flatMap(files);
  expect(sources.filter((file) => /geolocation|getCurrentPosition|watchPosition/.test(readFileSync(file, "utf8")))).toEqual([]);
  expect(readFileSync(join(__dirname, "../src-tauri/capabilities/default.json"), "utf8")).not.toMatch(/geolocation|location/i);
});

it("imports with an optional region, then changes it and reclassifies on request", async () => {
  const requests: string[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    requests.push(`${init?.method ?? "GET"} ${String(input)} ${String(init?.body ?? "")}`);
    const path = String(input).replace(`${API_ORIGIN}/api/client/v1/finance`, "");
    if (path === "") return new Response(JSON.stringify({ currency: null, version: "v0", statement_count: 0, transaction_count: 0 }), { status: 200 });
    if (path === "/statements") return new Response(JSON.stringify({ statements: [] }), { status: 200 });
    if (path === "/rules") return new Response(JSON.stringify({ rules: [] }), { status: 200 });
    if (path === "/categories") return new Response(JSON.stringify({ categories: [] }), { status: 200 });
    if (path.startsWith("/transactions")) return new Response(JSON.stringify({ transactions: [], next_after_id: null }), { status: 200 });
    return new Response("{}", { status: 200 });
  });

  render(<App />);
  fireEvent.change(await screen.findByLabelText("Email"), { target: { value: "region@example.com" } });
  fireEvent.change(screen.getByLabelText("Password"), { target: { value: "pw" } });
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Sign in" })));
  const create = await screen.findByRole("button", { name: "Create database" });
  await waitFor(() => expect(screen.getByLabelText<HTMLInputElement>("Database name").value).toBe("Test Mac"));
  await act(async () => fireEvent.click(create));
  await screen.findByRole("navigation");
  nav("Import");

  // Optional, starts as Not specified (the account's usage region is not used as a guess).
  const select = await screen.findByRole<HTMLSelectElement>("combobox", { name: "Country / Region (Optional)" });
  expect(select.value).toBe("");
  expect(select.selectedOptions[0].textContent).toBe("Not specified");
  for (const name of ["United States", "Mainland China", "Hong Kong", "Taiwan", "Canada", "United Kingdom", "Japan", "Singapore", "Australia", "Mexico"]) {
    expect(within(select).getByRole("option", { name: new RegExp(name) })).toBeTruthy();
  }
  expect(screen.getByText("Optional. Helps BillieWeather recognize regional banking formats and improve rule-based transaction categorization.")).toBeTruthy();

  fireEvent.change(select, { target: { value: "GB" } });
  const input = document.querySelector<HTMLInputElement>('input[type="file"]')!;
  const bytes = new TextEncoder().encode("%PDF-uk");
  const file = new File([bytes as BlobPart], "uk.pdf", { type: "application/pdf" });
  Object.defineProperty(file, "arrayBuffer", { value: async () => bytes.buffer.slice(0) });
  await act(async () => fireEvent.change(input, { target: { files: [file] } }));
  await screen.findByText(/Imported 3 transactions from uk\.pdf automatically/);
  await screen.findByText("Region: United Kingdom");

  // Change the region: metadata only.
  fireEvent.click(screen.getByRole("button", { name: "Change region" }));
  const editor = within(document.querySelector<HTMLElement>(".bw-simple-list")!).getByRole<HTMLSelectElement>("combobox", { name: "Country / Region (Optional)" });
  expect(editor.value).toBe("GB");
  fireEvent.change(editor, { target: { value: "US" } });
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Save region" })));
  await screen.findByText(/uk\.pdf: region saved\. No categories were changed/);
  await screen.findByText("Region: United States");

  // Then reclassify explicitly: the Tesco row was only recognized by the UK rules.
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Reclassify" })));
  await screen.findByText(/uk\.pdf: 1 transactions reclassified\. Categories you chose were kept\./);

  // No request ever carried the region or a statement.
  expect(requests.filter((request) => /region|TESCO|"GB"|"US"/.test(request.split(" ").slice(2).join(" ")))).toEqual([]);
  expect(requests.filter((request) => request.startsWith("POST") && request.includes("/finance/statements"))).toEqual([]);
});
