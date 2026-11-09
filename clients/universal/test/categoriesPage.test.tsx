// @vitest-environment jsdom
// The Categories page through the real UI: add a custom category, run "Categorize with AI"
// (consent panel → one request to the BillieWeather server → results applied locally), then
// open the category's details, rename it and delete it.
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import initSqlJs from "sql.js";
import { fixtureBytes, migrate } from "./helpers";
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

const account = { email: "cat@example.com", nickname: null, locale: "en", timeZone: null, usageRegion: "US", registeredAt: "2026-11-01T12:00:00Z", badges: [] };
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

const { default: App } = await import("../src/App");

const nav = (label: string) => fireEvent.click(within(screen.getByRole("navigation")).getByRole("button", { name: label }));

beforeEach(() => { localStorage.clear(); sessionStorage.clear(); localStorage.setItem("billie.locale", "en"); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

it("adds a category, categorizes with AI after consent, and manages the category", async () => {
  const categorize: Array<{ headers: Headers; body: Record<string, unknown> }> = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = String(input);
    if (url === `${API_ORIGIN}/api/client/v1/finance/categorize`) {
      categorize.push({ headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) });
      const items = (categorize.at(-1)!.body.items as Array<{ key: string; description: string }>);
      return new Response(JSON.stringify({ assignments: items.map((item) => ({ key: item.key, category: item.description.startsWith("AMAZON") ? "Cloud" : "Uncategorized" })) }), { status: 200 });
    }
    const path = url.replace(`${API_ORIGIN}/api/client/v1/finance`, "");
    if (path === "") return new Response(JSON.stringify({ currency: null, version: "v0", statement_count: 0, transaction_count: 0 }), { status: 200 });
    if (path === "/statements") return new Response(JSON.stringify({ statements: [] }), { status: 200 });
    if (path === "/rules") return new Response(JSON.stringify({ rules: [] }), { status: 200 });
    if (path === "/categories") return new Response(JSON.stringify({ categories: [] }), { status: 200 });
    if (path.startsWith("/transactions")) return new Response(JSON.stringify({ transactions: [], next_after_id: null }), { status: 200 });
    return new Response("{}", { status: 404 });
  });

  render(<App />);
  fireEvent.change(await screen.findByLabelText("Email"), { target: { value: "cat@example.com" } });
  fireEvent.change(screen.getByLabelText("Password"), { target: { value: "pw" } });
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Sign in" })));
  const create = await screen.findByRole("button", { name: "Create database" });
  // The name field is filled in with the device name asynchronously; an empty name is not submitted.
  await waitFor(() => expect(screen.getByLabelText<HTMLInputElement>("Database name").value).toBe("Test Mac"));
  await act(async () => fireEvent.click(create));
  await screen.findByRole("navigation");

  nav("Import");
  const input = await waitFor(() => document.querySelector<HTMLInputElement>('input[type="file"]')!);
  const bytes = fixtureBytes("basic-amount.csv");
  const file = new File([bytes as BlobPart], "basic-amount.csv", { type: "text/csv" });
  Object.defineProperty(file, "arrayBuffer", { value: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) });
  await act(async () => fireEvent.change(input, { target: { files: [file] } }));
  await screen.findByText(/9 transactions imported/);

  nav("Categories");
  await screen.findByRole("heading", { name: "All categories" });
  expect(screen.getByText("2 transaction(s) are Uncategorized. AI can suggest a category for each; categories you chose are never changed.")).toBeTruthy();

  fireEvent.change(screen.getByLabelText("New category"), { target: { value: "Cloud" } });
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Add category" })));
  await screen.findByText("Category “Cloud” added.");
  await act(async () => fireEvent.change(screen.getByLabelText("New category"), { target: { value: "shopping" } }));
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Add category" })));
  await screen.findByText("That is already a built-in category.");

  // Nothing is sent until the person confirms the consent panel, which shows exactly what goes.
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Categorize with AI" })));
  const consent = await screen.findByRole("dialog", { name: "Check what will be sent" });
  expect(categorize).toEqual([]);
  expect(within(consent).getByText("AMAZON WEB SERVICES AWS.AMAZON.CO")).toBeTruthy();
  expect(within(consent).getByText("HYPERLINK evil")).toBeTruthy();
  expect(consent.textContent).toContain("Your own categories: Cloud");
  await act(async () => fireEvent.click(within(consent).getByRole("button", { name: "Send and categorize" })));
  await screen.findByText("1 transaction(s) categorized from 2 merchant(s).");

  expect(categorize).toHaveLength(1);
  expect(categorize[0].headers.get("Authorization")).toBe("Bearer tok");
  expect(categorize[0].body).toEqual({
    consent: true,
    categories: ["Cloud"],
    items: [{ key: "1", description: "AMAZON WEB SERVICES AWS.AMAZON.CO", direction: "out" }, { key: "2", description: "HYPERLINK evil", direction: "out" }],
  });
  expect(JSON.stringify(categorize[0].body)).not.toMatch(/61\.2|6120|2026-|b\.csv|basic-amount/);

  // Details of the custom category: its transaction, then rename and delete.
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Show details for Cloud" })));
  await screen.findByRole("heading", { name: "Cloud" });
  expect(screen.getByText("AMAZON WEB SERVICES AWS.AMAZON.CO")).toBeTruthy();
  fireEvent.change(screen.getByLabelText("Category name"), { target: { value: "Cloud & hosting" } });
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Rename" })));
  await screen.findByText("Renamed “Cloud” to “Cloud & hosting”.");
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Delete category" })));
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Delete" })));
  await screen.findByText("Category “Cloud & hosting” deleted; 1 transaction(s) are now Uncategorized.");
  await screen.findByRole("heading", { name: "All categories" });

  // The Transactions page offers the person's categories too.
  fireEvent.change(screen.getByLabelText("New category"), { target: { value: "Pets" } });
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Add category" })));
  nav("Transactions");
  const select = (await screen.findByLabelText("Category for AMAZON WEB SERVICES AWS.AMAZON.CO")) as HTMLSelectElement;
  expect([...select.options].map((option) => option.value)).toContain("Pets");
});

it("explains a server without AI and an offline device, and changes nothing", async () => {
  let mode: "not_configured" | "offline" = "not_configured";
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = String(input);
    if (url.endsWith("/finance/categorize")) {
      if (mode === "offline") throw new TypeError("network down");
      return new Response(JSON.stringify({ error: "not_configured" }), { status: 503 });
    }
    if (url.endsWith("/finance")) return new Response(JSON.stringify({ currency: null, version: "v0" }), { status: 200 });
    if (url.endsWith("/statements")) return new Response(JSON.stringify({ statements: [] }), { status: 200 });
    if (url.endsWith("/rules")) return new Response(JSON.stringify({ rules: [] }), { status: 200 });
    if (url.includes("/transactions")) return new Response(JSON.stringify({ transactions: [], next_after_id: null }), { status: 200 });
    return new Response("{}", { status: 404 });
  });
  render(<App />);
  fireEvent.change(await screen.findByLabelText("Email"), { target: { value: "cat@example.com" } });
  fireEvent.change(screen.getByLabelText("Password"), { target: { value: "pw" } });
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Sign in" })));
  const create = await screen.findByRole("button", { name: "Create database" });
  // The name field is filled in with the device name asynchronously; an empty name is not submitted.
  await waitFor(() => expect(screen.getByLabelText<HTMLInputElement>("Database name").value).toBe("Test Mac"));
  await act(async () => fireEvent.click(create));
  await screen.findByRole("navigation");
  nav("Import");
  const input = await waitFor(() => document.querySelector<HTMLInputElement>('input[type="file"]')!);
  const bytes = fixtureBytes("basic-amount.csv");
  const file = new File([bytes as BlobPart], "basic-amount.csv", { type: "text/csv" });
  Object.defineProperty(file, "arrayBuffer", { value: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) });
  await act(async () => fireEvent.change(input, { target: { files: [file] } }));
  await screen.findByText(/9 transactions imported/);

  nav("Categories");
  for (const [next, message] of [["not_configured", "AI categorization isn't connected on the BillieWeather server yet."], ["offline", "Can't reach BillieWeather. AI categorization needs an internet connection; nothing was changed."]] as const) {
    mode = next;
    const start = await screen.findByRole("button", { name: "Categorize with AI" });
    await act(async () => fireEvent.click(start));
    const send = await screen.findByRole("button", { name: "Send and categorize" });
    await act(async () => fireEvent.click(send));
    await screen.findByText(message);
  }
  expect(screen.getByText("2 transaction(s) are Uncategorized. AI can suggest a category for each; categories you chose are never changed.")).toBeTruthy();
});
