// @vitest-environment jsdom
// Importing a PDF through the real UI: a clear statement imports straight away; an unclear
// one opens the review, where a row is corrected, another left out, and nothing is saved
// until the person confirms. (PDF text reading itself is covered in pdfImport.test.ts.)
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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

const account = { email: "pdf@example.com", nickname: null, locale: "en", timeZone: null, usageRegion: "US", registeredAt: "2026-11-01T12:00:00Z", badges: [] };
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

// Page text per file, keyed by the file's first bytes.
const PAGES: Record<string, string[]> = {
  "%PDF-clear": ["Statement period: October 1, 2025 through October 31, 2025\n10/02 Payroll ACME Corp +2,400.00\n10/05 Grocery Market -86.35\n"],
  "%PDF-unclear": ["Statement period ending 2025-11-30\n11/03 Bookstore 24.10\n11/04 Bakery -3.50\n11/05 Running total 10.00 990.00\n"],
};
vi.mock("../src/services/pdfText", () => ({
  readPdfPages: async (bytes: Uint8Array) => PAGES[new TextDecoder().decode(bytes)],
}));

const { default: App } = await import("../src/App");
const nav = (label: string) => fireEvent.click(within(screen.getByRole("navigation")).getByRole("button", { name: label }));

beforeEach(() => { localStorage.clear(); sessionStorage.clear(); localStorage.setItem("billie.locale", "en"); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

async function upload(name: string, content: string) {
  const input = await waitFor(() => document.querySelector<HTMLInputElement>('input[type="file"]')!);
  expect(input.accept).toContain(".pdf");
  const bytes = new TextEncoder().encode(content);
  const file = new File([bytes as BlobPart], name, { type: "application/pdf" });
  Object.defineProperty(file, "arrayBuffer", { value: async () => bytes.buffer.slice(0) });
  await act(async () => fireEvent.change(input, { target: { files: [file] } }));
}

it("imports a clear PDF directly and reviews an unclear one before importing", async () => {
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const path = String(input).replace(`${API_ORIGIN}/api/client/v1/finance`, "");
    if (path === "") return new Response(JSON.stringify({ currency: null, version: "v0", statement_count: 0, transaction_count: 0 }), { status: 200 });
    if (path === "/statements") return new Response(JSON.stringify({ statements: [] }), { status: 200 });
    if (path === "/rules") return new Response(JSON.stringify({ rules: [] }), { status: 200 });
    if (path === "/categories") return new Response(JSON.stringify({ categories: [] }), { status: 200 });
    if (path.startsWith("/transactions")) return new Response(JSON.stringify({ transactions: [], next_after_id: null }), { status: 200 });
    return new Response("{}", { status: 404 });
  });

  render(<App />);
  fireEvent.change(await screen.findByLabelText("Email"), { target: { value: "pdf@example.com" } });
  fireEvent.change(screen.getByLabelText("Password"), { target: { value: "pw" } });
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Sign in" })));
  const create = await screen.findByRole("button", { name: "Create database" });
  // The name field is filled in with the device name asynchronously; an empty name is not submitted.
  await waitFor(() => expect(screen.getByLabelText<HTMLInputElement>("Database name").value).toBe("Test Mac"));
  await act(async () => fireEvent.click(create));
  await screen.findByRole("navigation");
  nav("Import");

  await upload("october.pdf", "%PDF-clear");
  await screen.findByText(/Imported 2 transactions from october\.pdf automatically/);

  await upload("november.pdf", "%PDF-unclear");
  await screen.findByRole("heading", { name: "Review your extracted transactions." });
  const highlighted = within(document.querySelector<HTMLElement>(".bw-pdf-warnings")!);
  expect(highlighted.getByText("Row 1: the amount has no debit/credit sign. Enter a positive income or negative expense amount.")).toBeTruthy();
  expect(highlighted.getByText(/Row 3: multiple amount columns/)).toBeTruthy();

  const submit = screen.getByRole("button", { name: "Confirm and import transactions" }) as HTMLButtonElement;
  expect(submit.disabled).toBe(true); // needs the "I reviewed" confirmation
  fireEvent.change(screen.getByLabelText("Signed amount for row 1"), { target: { value: "-24.10" } });
  fireEvent.click(screen.getByLabelText("Include row 3"));
  fireEvent.click(screen.getByLabelText(/I reviewed the included rows/));
  await act(async () => fireEvent.click(submit));
  await screen.findByText(/november\.pdf: Imported 2 reviewed PDF transactions/);

  nav("Transactions");
  await screen.findByText("Bookstore");
  expect(screen.queryByText("Running total")).toBeNull();
});
