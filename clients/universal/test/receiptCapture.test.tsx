// @vitest-environment jsdom
// Receipt capture through the real screens: a photo read by an on-device OCR engine (a fake one
// here) -> the review form marks uncertain and missing fields -> the duplicate guard compares with
// the local ledger -> exactly one manual expense. "Send to BillieWeather web" only on the button,
// with a stable client_request_id. Deep links open the capture screen. Synthetic data only.
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { OcrLine, OcrResult } from "@billie/finance-core";
import initSqlJs from "sql.js";
import { migrate } from "./helpers";
import { sqljsDriver } from "../src/services/sqljsDriver";
import { FinanceStore } from "../src/services/store";
import { registerOcrEngine } from "../src/services/ocrEngine";
import { resetDeepLinksForTests, routeFromHash, routeFromUrl } from "../src/services/deepLink";
import { receiptLinesFromPages } from "../src/services/receipt";

const files = new Map<string, ReturnType<typeof sqljsDriver>>();
vi.mock("../src/services/platform", async () => {
  const SQL = await initSqlJs();
  return {
    isTauri: () => false,
    openDatabase: async (file = "billieweather.db") => {
      if (!files.has(file)) {
        const db = new SQL.Database();
        migrate(db);
        db.run("INSERT INTO settings (key, value) VALUES ('owner_account_id', 'id:12345678-1234-4123-8123-123456789abc')");
        db.run("INSERT INTO settings (key, value) VALUES ('database_name', 'Receipt book')");
        files.set(file, sqljsDriver(db));
      }
      return { driver: files.get(file)!, persistent: true };
    },
    deviceName: async () => "Mac",
    deviceIdentity: async () => null,
    saveFile: async () => true,
    listSnapshots: async () => [],
  };
});

const { default: App } = await import("../src/App");
const { openDatabase } = await import("../src/services/platform");

type Call = { url: string; method: string; body: string | null };
let calls: Call[] = [];
let receiptResponses: Array<{ status: number; body: unknown }> = [];

beforeEach(() => {
  localStorage.clear(); sessionStorage.clear(); files.clear(); calls = []; receiptResponses = [];
  localStorage.setItem("billie.locale", "en");
  sessionStorage.setItem("billie.token", "tok");
  window.history.replaceState(null, "", "/");
  resetDeepLinksForTests();
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = String(input);
    calls.push({ url, method: init?.method ?? "GET", body: typeof init?.body === "string" ? init.body : null });
    if (url.endsWith("/account")) return new Response(JSON.stringify({ account: { email: "r@example.com", nickname: null, locale: "en", time_zone: null, usage_region: "US", registered_at: null, badges: [], owner_id: "12345678-1234-4123-8123-123456789abc" } }), { status: 200 });
    if (url.endsWith("/finance/receipts")) {
      const next = receiptResponses.shift() ?? { status: 500, body: {} };
      return new Response(JSON.stringify(next.body), { status: next.status });
    }
    return new Response(JSON.stringify({ currency: null, version: "0", statement_count: 0, transaction_count: 0, statements: [], transactions: [], next_after_id: null, rules: [], categories: [] }), { status: 200 });
  });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); registerOcrEngine(null); });

const click = async (element: HTMLElement) => act(async () => { fireEvent.click(element); });
const nav = (name: string) => fireEvent.click(within(screen.getByRole("navigation")).getByRole("button", { name }));

/** Engine-style observations: the label and the amount of one printed row come as two lines (Apple Vision does). */
const line = (text: string, x: number, y: number, confidence: number | null = 0.95): OcrLine => ({ text, x, y, width: text.length * 10, height: 20, confidence, words: [] });
const RECEIPT_LINES: OcrLine[] = [
  line("BLUE BOTTLE COFFEE", 10, 10),
  line("123 Main St", 10, 40),
  line("Date: 11/14/2026 08:31", 10, 70),
  line("Latte", 10, 120), line("5.50", 300, 121),
  line("Croissant", 10, 150), line("7.00", 300, 150),
  // A hard-to-read total: below the 0.8 the person must check.
  line("TOTAL", 10, 200, 0.6), line("12.50", 300, 202, 0.6),
  line("VISA ****1234", 10, 240),
];

function fakeEngine(lines = RECEIPT_LINES) {
  const result: OcrResult = { engine: { id: "fake-device-ocr", version: "1" }, languages: ["en"], pages: [{ page: 1, width: 400, height: 300, rotation: 0, lines }], errors: [], unsupported: [] };
  const recognize = vi.fn(async () => result);
  registerOcrEngine({ info: { id: "fake-device-ocr", location: "device", languages: ["en"] }, recognize });
  return recognize;
}

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
async function uploadReceipt() {
  const input = await screen.findByLabelText("Upload receipt") as HTMLInputElement;
  const file = new File([PNG as BlobPart], "receipt.png", { type: "image/png" });
  Object.defineProperty(file, "arrayBuffer", { value: async () => PNG.buffer.slice(0) });
  await act(async () => { fireEvent.change(input, { target: { files: [file] } }); });
  return screen.findByRole("form", { name: "Check the receipt" });
}

/** A book in USD with one card account, optionally holding the bank's copy of the purchase. */
async function seed(options: { existing?: boolean } = {}) {
  const { driver } = await openDatabase();
  const store = new FinanceStore(driver);
  await store.ledger.setBookCurrency("USD");
  const card = await store.ledger.createAccount({ name: "ZXQ Card", type: "credit_card" });
  if (options.existing) await store.ledger.createEntry({ kind: "expense", amountCents: 1250, occurredOn: "2026-11-14", accountId: card.id, category: "Food & dining", description: "BLUE BOTTLE COFFEE" });
  return { driver, card };
}

const entries = async (driver: Awaited<ReturnType<typeof seed>>["driver"]) =>
  driver.select<{ description: string; amount_cents: number; kind: string; note: string | null; booked_on: string; occurred_at_time: string | null }>("SELECT description, amount_cents, kind, note, booked_on, occurred_at_time FROM transactions WHERE deleted_at IS NULL ORDER BY id");

async function openReceipts() {
  render(<App />);
  await screen.findByRole("navigation");
  nav("Receipts");
  await screen.findByRole("heading", { name: "Capture a receipt" });
}

it("joins an engine's left and right observations of one printed row", () => {
  const lines = receiptLinesFromPages([{ page: 1, width: 400, height: 300, rotation: 0, lines: RECEIPT_LINES }]);
  expect(lines.map((item) => item.text)).toContain("TOTAL   12.50");
  expect(lines.find((item) => item.text.startsWith("TOTAL"))!.confidence).toBe(0.6);
});

it("reads a receipt on the device and marks uncertain and missing fields instead of presenting guesses", async () => {
  const recognize = fakeEngine();
  await seed();
  await openReceipts();
  // Both capture actions: the camera (iOS/Android WebViews open it for capture="environment") and upload.
  const scan = document.querySelector<HTMLInputElement>('input[capture="environment"]')!;
  expect(scan.accept).toBe("image/*");
  const form = await uploadReceipt();
  expect(recognize).toHaveBeenCalledTimes(1);

  const value = (label: string) => (within(form).getByLabelText(label) as HTMLInputElement).value;
  const certainty = (label: string) => within(form).getByLabelText(label).getAttribute("data-certainty");
  expect(value("Merchant")).toBe("BLUE BOTTLE COFFEE");
  expect(certainty("Merchant")).toBe("read");
  expect(value("Date")).toBe("2026-11-14");
  expect(certainty("Date")).toBe("read");
  expect(value("Time")).toBe("08:31");
  // The total was hard to read: shown, but marked for checking.
  expect(value("Total")).toBe("12.50");
  expect(certainty("Total")).toBe("uncertain");
  expect(within(form).getByLabelText("Total").getAttribute("aria-describedby")).toBe("receipt-total-certainty");
  expect(document.getElementById("receipt-total-certainty")!.textContent).toBe("Uncertain, please check");
  // No currency on the receipt: the book's is assumed and said so.
  expect(value("Currency")).toBe("USD");
  expect(certainty("Currency")).toBe("uncertain");
  expect(within(form).getByText("The receipt doesn't name its currency: your book's currency was assumed.")).toBeTruthy();
  // Nothing read for tax and tip: empty and marked missing, never filled with a guess.
  expect(value("Tax")).toBe("");
  expect(certainty("Tax")).toBe("missing");
  expect(document.getElementById("receipt-tax-certainty")!.textContent).toBe("Missing");
  expect(certainty("Card (last 4 digits)")).toBe("read");
  expect(value("Card (last 4 digits)")).toBe("1234");
  // Line items are listed read-only; the categorizer suggests a category from the merchant.
  expect(within(form).getByText("Latte")).toBeTruthy();
  expect((within(form).getByLabelText("Category") as HTMLSelectElement).value).toBe("Food & dining");
  expect(within(form).getByText(/Suggested from the merchant name/)).toBeTruthy();

  // The person must confirm the uncertain fields before anything is saved.
  await click(within(form).getByRole("button", { name: "Check for duplicates and save" }));
  expect(within(form).getByText("Confirm that you checked the uncertain fields.")).toBeTruthy();
  // Editing a field marks it as the person's.
  fireEvent.change(within(form).getByLabelText("Total"), { target: { value: "12.5" } });
  expect(certainty("Total")).toBe("edited");
});

it("blocks a receipt that matches an existing local transaction, and adds it only when the person says it's a different purchase", async () => {
  fakeEngine();
  const { driver } = await seed({ existing: true });
  await openReceipts();
  let form = await uploadReceipt();
  fireEvent.click(within(form).getByLabelText("I checked the fields marked Uncertain or Missing"));
  await click(within(form).getByRole("button", { name: "Check for duplicates and save" }));
  const guard = await screen.findByRole("alertdialog", { name: "Already in your transactions?" });
  expect(guard.textContent).toContain("This receipt looks like an existing transaction (2026-11-14, BLUE BOTTLE COFFEE, -$12.50) — it will not be added again.");
  expect(await entries(driver)).toHaveLength(1); // nothing written while the person decides

  // "Keep as the same purchase": nothing is added and the existing entry is untouched.
  await click(within(guard).getByRole("button", { name: "Keep as the same purchase (don't add)" }));
  expect(await screen.findByText("Not added: this receipt is the existing transaction “BLUE BOTTLE COFFEE”.")).toBeTruthy();
  expect(await entries(driver)).toEqual([{ description: "BLUE BOTTLE COFFEE", amount_cents: -1250, kind: "expense", note: null, booked_on: "2026-11-14", occurred_at_time: null }]);

  // The same receipt again, and this time it really was a second purchase.
  await click(screen.getByRole("button", { name: "Capture another receipt" }));
  form = await uploadReceipt();
  fireEvent.click(within(form).getByLabelText("I checked the fields marked Uncertain or Missing"));
  await click(within(form).getByRole("button", { name: "Check for duplicates and save" }));
  await click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "It's a different purchase (add anyway)" }));
  expect(await screen.findByText("Saved as an expense: BLUE BOTTLE COFFEE, $12.50.")).toBeTruthy();
  const rows = await entries(driver);
  expect(rows).toHaveLength(2);
  expect(rows[1]).toEqual({ description: "BLUE BOTTLE COFFEE", amount_cents: -1250, kind: "expense", note: "From receipt", booked_on: "2026-11-14", occurred_at_time: "08:31" });
  expect(rows[0].note).toBeNull(); // the bank's entry was never edited
});

it("asks the person to choose when several transactions could be the receipt", async () => {
  fakeEngine();
  const { driver, card } = await seed({ existing: true });
  const store = new FinanceStore(driver);
  await store.ledger.createEntry({ kind: "expense", amountCents: 1250, occurredOn: "2026-11-15", accountId: card.id, category: "Food & dining", description: "BLUE BOTTLE COFFEE" });
  await openReceipts();
  const form = await uploadReceipt();
  fireEvent.click(within(form).getByLabelText("I checked the fields marked Uncertain or Missing"));
  await click(within(form).getByRole("button", { name: "Check for duplicates and save" }));
  const guard = await screen.findByRole("alertdialog", { name: "Several transactions could be this receipt" });
  const keep = within(guard).getByRole("button", { name: "It's the chosen transaction (don't add)" }) as HTMLButtonElement;
  expect(keep.disabled).toBe(true); // a choice is required
  expect(within(guard).getAllByRole("radio")).toHaveLength(2);
  fireEvent.click(within(guard).getByLabelText("2026-11-15 · BLUE BOTTLE COFFEE · -$12.50"));
  await click(keep);
  expect(await screen.findByText(/Not added/)).toBeTruthy();
  expect(await entries(driver)).toHaveLength(2);
});

it("saves exactly one entry per capture, and a re-captured copy of a saved receipt is caught", async () => {
  fakeEngine();
  const { driver } = await seed();
  await openReceipts();
  let form = await uploadReceipt();
  fireEvent.change(within(form).getByLabelText("Receipt number"), { target: { value: "A-1009" } });
  fireEvent.click(within(form).getByLabelText("I checked the fields marked Uncertain or Missing"));
  const save = within(form).getByRole("button", { name: "Check for duplicates and save" });
  // Two presses in a row (double click) before the first save finishes.
  await act(async () => { fireEvent.click(save); fireEvent.click(save); });
  expect(await screen.findByText("Saved as an expense: BLUE BOTTLE COFFEE, $12.50.")).toBeTruthy();
  let rows = await entries(driver);
  expect(rows).toHaveLength(1);
  expect(rows[0].note).toBe("From receipt · No. A-1009");

  // Photographing the same receipt again finds the entry just saved; nothing is added by itself.
  await click(screen.getByRole("button", { name: "Capture another receipt" }));
  form = await uploadReceipt();
  fireEvent.click(within(form).getByLabelText("I checked the fields marked Uncertain or Missing"));
  await click(within(form).getByRole("button", { name: "Check for duplicates and save" }));
  expect((await screen.findByRole("alertdialog")).textContent).toContain("it will not be added again");
  rows = await entries(driver);
  expect(rows).toHaveLength(1);
  // No receipt request was ever made: nothing leaves the device unless Send is pressed.
  expect(calls.filter((call) => call.url.includes("/receipts"))).toEqual([]);
  expect(calls.filter((call) => call.body !== null && /BLUE BOTTLE|12\.50/.test(call.body))).toEqual([]);
});

it("sends to BillieWeather web only when the person presses Send, with the same client_request_id on a retry", async () => {
  fakeEngine();
  await seed();
  await openReceipts();
  await uploadReceipt();
  expect(calls.filter((call) => call.url.includes("/receipts"))).toEqual([]);

  receiptResponses.push({ status: 500, body: {} });
  await click(screen.getByRole("button", { name: "Send to BillieWeather web" }));
  expect(await screen.findByText("The receipt couldn't be sent. Try again: it will not be added twice.")).toBeTruthy();
  receiptResponses.push({ status: 201, body: { created: true, receipt: { id: 7, status: "pending_bank_match", verification: "unverified", issues: [], match: null, duplicate_of: null } } });
  await click(screen.getByRole("button", { name: "Send to BillieWeather web" }));
  expect(await screen.findByText("Sent to BillieWeather web: waiting for the bank transaction.")).toBeTruthy();

  const sent = calls.filter((call) => call.url.endsWith("/api/client/v1/finance/receipts"));
  expect(sent).toHaveLength(2);
  expect(sent.every((call) => call.method === "POST")).toBe(true);
  const [first, second] = sent.map((call) => JSON.parse(call.body!).receipt);
  expect(first.client_request_id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  expect(second.client_request_id).toBe(first.client_request_id);
  expect(second).toEqual({
    client_request_id: first.client_request_id, source: "app", engine: "fake-device-ocr",
    lines: expect.arrayContaining([{ text: "BLUE BOTTLE COFFEE", confidence: 0.95 }, { text: "TOTAL   12.50", confidence: 0.6 }]),
    fields: { merchant: "BLUE BOTTLE COFFEE", date: "2026-11-14", time: "08:31", total: "12.50", currency: "USD", tax: null, tip: null, payment_method: "card", card_last4: "1234", receipt_number: null, direction: "purchase" },
    file_base64: btoa(String.fromCharCode(...PNG)), filename: "receipt.png", content_type: "image/png",
  });
  expect(Object.keys(second).sort()).toEqual(["client_request_id", "content_type", "engine", "fields", "file_base64", "filename", "lines", "source"]);
  const authorization = (vi.mocked(fetch).mock.calls.find(([input]) => String(input).endsWith("/receipts"))![1]!.headers as Record<string, string>).Authorization;
  expect(authorization).toBe("Bearer tok");
});

describe("deep links", () => {
  it("accepts only the allowlisted screens and never data", () => {
    expect(routeFromUrl("billieweather://capture/receipt")).toBe("capture/receipt");
    expect(routeFromUrl("billieweather:///capture/expense/")).toBe("capture/expense");
    expect(routeFromUrl("BillieWeather://open")).toBe("open");
    expect(routeFromUrl("billieweather://")).toBe("open");
    expect(routeFromUrl("billieweather://capture/receipt?amount=12.50")).toBe("capture/receipt");
    expect(routeFromUrl("billieweather://delete/all")).toBeNull();
    expect(routeFromUrl("https://example.com/capture/receipt")).toBeNull();
    expect(routeFromHash("#/capture/receipt")).toBe("capture/receipt");
    expect(routeFromHash("#capture/expense")).toBe("capture/expense");
    expect(routeFromHash("#/settings")).toBeNull();
  });

  it("#/capture/receipt opens the receipt capture screen", async () => {
    await seed();
    window.history.replaceState(null, "", "/#/capture/receipt");
    render(<App />);
    expect(await screen.findByRole("heading", { name: "Capture a receipt" })).toBeTruthy();
    expect(screen.getByLabelText("Upload receipt")).toBeTruthy();
    expect(window.location.hash).toBe(""); // consumed, so it can be opened again
    // A link that arrives while the app is open.
    nav("Dashboard");
    await waitFor(() => expect(screen.queryByRole("heading", { name: "Capture a receipt" })).toBeNull());
    await act(async () => { window.location.hash = "#/capture/receipt"; window.dispatchEvent(new HashChangeEvent("hashchange")); });
    expect(await screen.findByRole("heading", { name: "Capture a receipt" })).toBeTruthy();
  });

  it("#/capture/expense opens the manual entry form", async () => {
    await seed();
    window.history.replaceState(null, "", "/#/capture/expense");
    render(<App />);
    expect(await screen.findByRole("form", { name: "New entry" })).toBeTruthy();
  });

  it("the Import page links to receipt capture", async () => {
    await seed();
    render(<App />);
    await screen.findByRole("navigation");
    nav("Import");
    await click(await screen.findByRole("button", { name: "Scan or upload a receipt" }));
    expect(await screen.findByRole("heading", { name: "Capture a receipt" })).toBeTruthy();
  });
});
