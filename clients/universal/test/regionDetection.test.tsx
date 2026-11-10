// @vitest-environment jsdom
// Automatic region detection on import and the region validator, through the store (real SQLite
// migrations, sql.js) and the real Import page. Detection is a suggestion: it never changes the
// region a person selected. Synthetic data only.
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import initSqlJs from "sql.js";
import { checkRegion } from "@billie/finance-core";
import { migrate, newStore } from "./helpers";
import { sqljsDriver } from "../src/services/sqljsDriver";
import { FinanceStore } from "../src/services/store";
import { commitDraft, detectDraftRegion, importContext, importDraftFile } from "../src/services/universalImport";
import { API_ORIGIN } from "../src/services/account";

const enc = (text: string) => new TextEncoder().encode(text);

// A U.S. bank export: bank name and routing number in the header lines, Zelle in a row.
const US_CSV = enc([
  "Bank: Bank of America",
  "Routing number: 021000021",
  "Date,Description,Amount",
  "2026-03-01,ACME CORP PAYROLL,2500.00",
  "2026-03-02,ZELLE PAYMENT TO J SMITH,-40.00",
  "2026-03-05,MYSTERY VENDOR 99,-9.99",
].join("\n"));

// No evidence at all.
const PLAIN_CSV = enc(["Date,Description,Amount", "2026-03-01,SALARY,2500.00", "2026-03-02,MYSTERY VENDOR,-9.99"].join("\n"));

async function importWith(store: FinanceStore, bytes: Uint8Array, region: string | null) {
  const draft = await importDraftFile(store, bytes, "s.csv", "USD", undefined, region);
  return commitDraft(store, draft, await importContext(store, region), { source: region ? "user" : null, detection: detectDraftRegion(draft) });
}

const statementRow = (db: import("sql.js").Database) =>
  db.exec("SELECT region, region_source, detected_region, region_confidence, region_evidence FROM statements")[0].values[0];

describe("store: detection is stored apart from the selection", () => {
  it("Scenario A: nothing selected; the detection is kept, the region stays Not specified", async () => {
    const { db, store } = await newStore();
    await importWith(store, US_CSV, null);
    const [region, source, detected, confidence, evidence] = statementRow(db);
    expect([region, source, detected, confidence]).toEqual([null, null, "US", "high"]);
    // Evidence names rules only, never the file's numbers or descriptions.
    expect(String(evidence)).toContain("Bank of America");
    expect(String(evidence)).not.toMatch(/021000021|SMITH|ACME/);
    const [item] = await store.importHistory();
    expect(checkRegion(item.region, item.detection)).toEqual({ kind: "suggest", detected: "US" });

    // Accepting is an explicit step and is recorded as such.
    await store.setStatementRegion(item.statementIds, "US", "suggestion");
    expect(statementRow(db).slice(0, 2)).toEqual(["US", "suggestion"]);
    const [after] = await store.importHistory();
    expect(checkRegion(after.region, after.detection).kind).toBe("match");
  });

  it("Scenario B: the selection matches; nothing to show", async () => {
    const { store } = await newStore();
    await importWith(store, US_CSV, "US");
    const [item] = await store.importHistory();
    expect([item.region, item.regionSource]).toEqual(["US", "user"]);
    expect(checkRegion(item.region, item.detection).kind).toBe("match");
  });

  it("Scenario C: a conflicting selection is never overridden; Keep my selection silences the warning", async () => {
    const { db, store } = await newStore();
    await importWith(store, US_CSV, "CN");
    const [item] = await store.importHistory();
    expect(item.region).toBe("CN");
    expect(checkRegion(item.region, item.detection)).toEqual({ kind: "conflict", selected: "CN", detected: "US" });
    await store.keepStatementRegion(item.statementIds);
    expect(statementRow(db).slice(0, 3)).toEqual(["CN", "user_confirmed", "US"]);
    const [kept] = await store.importHistory();
    expect(checkRegion(kept.region, kept.detection, { keptSelection: kept.regionSource === "user_confirmed" }).kind).toBe("none");
  });

  it("Scenario D: insufficient evidence; no detection, no prompt", async () => {
    const { db, store } = await newStore();
    await importWith(store, PLAIN_CSV, "CN");
    const [region, source, detected] = statementRow(db);
    // The detection only saw the USD currency fallback: Low at most, never a warning.
    expect([region, source]).toEqual(["CN", "user"]);
    expect(detected === null || statementRow(db)[3] === "low").toBe(true);
    const [item] = await store.importHistory();
    expect(checkRegion(item.region, item.detection).kind).toBe("none");
  });

  it("migration 6 keeps old regions and marks them as chosen by a person", async () => {
    const SQL = await initSqlJs();
    const db = new SQL.Database();
    migrate(db, 5);
    db.run("INSERT INTO statements (id, filename, currency, sha256, transaction_count, imported_at, source_sha256, region) VALUES (1, 'a.csv', 'USD', ?, 0, 'x', ?, 'GB')", ["a".repeat(64), "a".repeat(64)]);
    db.run("INSERT INTO statements (id, filename, currency, sha256, transaction_count, imported_at, source_sha256) VALUES (2, 'b.csv', 'USD', ?, 0, 'x', ?)", ["b".repeat(64), "b".repeat(64)]);
    migrate(db);
    expect(db.exec("SELECT id, region, region_source, detected_region, region_confidence, region_evidence FROM statements ORDER BY id")[0].values)
      .toEqual([[1, "GB", "user", null, null, null], [2, null, null, null, null, null]]);
    const history = await new FinanceStore(sqljsDriver(db)).importHistory();
    expect(history.every((item) => item.detection.detectedRegion === null)).toBe(true);
  });
});

// ---------- the real Import page ----------

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

const account = { email: "detect@example.com", nickname: null, locale: "en", timeZone: null, usageRegion: "CN", registeredAt: "2026-11-01T12:00:00Z", badges: [] };
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

async function openImport() {
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const path = String(input).replace(`${API_ORIGIN}/api/client/v1/finance`, "");
    if (path === "") return new Response(JSON.stringify({ currency: null, version: "v0", statement_count: 0, transaction_count: 0 }), { status: 200 });
    if (path === "/statements") return new Response(JSON.stringify({ statements: [] }), { status: 200 });
    if (path === "/rules") return new Response(JSON.stringify({ rules: [] }), { status: 200 });
    if (path === "/categories") return new Response(JSON.stringify({ categories: [] }), { status: 200 });
    if (path.startsWith("/transactions")) return new Response(JSON.stringify({ transactions: [], next_after_id: null }), { status: 200 });
    return new Response("{}", { status: 200 });
  });
  render(<App />);
  fireEvent.change(await screen.findByLabelText("Email"), { target: { value: "detect@example.com" } });
  fireEvent.change(screen.getByLabelText("Password"), { target: { value: "pw" } });
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Sign in" })));
  const create = await screen.findByRole("button", { name: "Create database" });
  await waitFor(() => expect(screen.getByLabelText<HTMLInputElement>("Database name").value).toBe("Test Mac"));
  await act(async () => fireEvent.click(create));
  await screen.findByRole("navigation");
  nav("Import");
  return screen.findByRole<HTMLSelectElement>("combobox", { name: "Country / Region (Optional)" });
}

async function upload(bytes: Uint8Array, name: string) {
  const input = document.querySelector<HTMLInputElement>('input[type="file"]')!;
  const file = new File([bytes as BlobPart], name, { type: "text/csv" });
  Object.defineProperty(file, "arrayBuffer", { value: async () => bytes.buffer.slice(0) });
  await act(async () => fireEvent.change(input, { target: { files: [file] } }));
}

it("Scenario A in the UI: suggests the detected region; accepting it is saved as an accepted suggestion", async () => {
  const select = await openImport();
  // The account's usage region (CN here) is never used as a default.
  expect(select.value).toBe("");
  await upload(US_CSV, "us.csv");
  const notice = await screen.findByText(/Suggested region: United States\. This statement appears to originate from United States \(high confidence\)/);
  expect(notice.closest("[data-region-check]")!.textContent).toMatch(/Bank: Bank of America/);
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Use detected region" })));
  await waitFor(() => expect(document.querySelector("[data-region-check]")).toBeNull());
  await act(async () => fireEvent.click(screen.getByRole("button", { name: /^Import \d+ transactions$/ })));
  await screen.findByText("Region: United States");
  await screen.findByText("Detected: United States (high)");
});

it("Scenario C in the UI: warns about a conflicting selection and keeps it on request", async () => {
  const select = await openImport();
  fireEvent.change(select, { target: { value: "CN" } });
  await upload(US_CSV, "us.csv");
  await screen.findByText("This statement appears to originate from United States, but you selected Mainland China. Please verify your selection.");
  // Non-blocking: the import button is still there.
  expect(screen.getByRole("button", { name: /^Import \d+ transactions$/ })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Keep my selection" }));
  await waitFor(() => expect(document.querySelector("[data-region-check]")).toBeNull());
  await act(async () => fireEvent.click(screen.getByRole("button", { name: /^Import \d+ transactions$/ })));
  await screen.findByText("Region: Mainland China");
  // Kept: no warning in the history either.
  expect(document.querySelector("[data-region-check]")).toBeNull();
});

it("Scenario C after import: the history warning can switch to the detected region", async () => {
  const select = await openImport();
  fireEvent.change(select, { target: { value: "CN" } });
  await upload(US_CSV, "us.csv");
  await screen.findByText(/but you selected Mainland China/);
  // Import without answering: the warning moves to the import history.
  await act(async () => fireEvent.click(screen.getByRole("button", { name: /^Import \d+ transactions$/ })));
  await screen.findByText("Region: Mainland China");
  await screen.findByText(/but you selected Mainland China/);
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Use detected region" })));
  await screen.findByText(/us\.csv: region set to United States; \d+ transactions reclassified\./);
  await screen.findByText("Region: United States");
});

it("Scenario D in the UI: no evidence, no prompt", async () => {
  const select = await openImport();
  fireEvent.change(select, { target: { value: "CN" } });
  await upload(PLAIN_CSV, "plain.csv");
  await screen.findByRole("button", { name: /^Import \d+ transactions$/ });
  expect(document.querySelector("[data-region-check]")).toBeNull();
});

it("region names follow the interface language", async () => {
  localStorage.setItem("billie.locale", "zh-CN");
  const { MESSAGES } = await import("../src/i18n");
  expect(MESSAGES["zh-CN"].universal.region.names.CN).toBe("中国大陆");
  expect(MESSAGES["zh-TW"].universal.region.names.CN).toBe("中國大陸");
  expect(MESSAGES.en.universal.region.names.CN).toBe("Mainland China");
  expect(Object.keys(MESSAGES.en.universal.region.names)).toHaveLength(19);
});
