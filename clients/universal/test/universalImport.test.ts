// @vitest-environment jsdom
// Universal import against the real SQLite migrations (sql.js). Synthetic data only.
import initSqlJs from "sql.js";
import { buildSnapshot, commitPlan, reviseDraft, statementHashes, templateFrom, type ImportDraft } from "@billie/finance-core";
import { CURRENCIES } from "@billie/shared-types";
import { fixtureBytes, migrate, newStore } from "./helpers";
import { sqljsDriver } from "../src/services/sqljsDriver";
import { FinanceStore, type SqlDriver } from "../src/services/store";
import { importContext, importDraftFile, commitDraft } from "../src/services/universalImport";

const enc = (text: string) => new TextEncoder().encode(text);

async function confirmAll(store: FinanceStore, draft: ImportDraft) {
  return commitDraft(store, draft, await importContext(store));
}

describe("migration 4", () => {
  it("keeps every existing value and fills the new columns from data the rows already had", async () => {
    const SQL = await initSqlJs();
    const db = new SQL.Database();
    migrate(db, 3);
    db.run("INSERT INTO statements (id, filename, currency, sha256, transaction_count, closing_balance_cents, closing_balance_on, imported_at) VALUES (1, 'old.csv', 'EUR', ?, 2, 5000, '2026-01-03', '2026-01-04T00:00:00Z')", ["b".repeat(64)]);
    db.run("INSERT INTO transactions (statement_id, booked_on, description, amount_cents, category, tax_review, excluded, updated_at, locally_modified) VALUES (1, '2026-01-02', 'Café 東京', -1250, 'Food & dining', 0, 0, 'x', 1), (1, '2026-01-03', 'Gehalt', 300000, 'Income', 0, 0, 'x', 0)");
    const before = db.exec("SELECT id, statement_id, booked_on, description, amount_cents, category, tax_review, excluded, updated_at, remote_id, locally_modified FROM transactions ORDER BY id")[0].values;
    migrate(db);
    const after = db.exec("SELECT id, statement_id, booked_on, description, amount_cents, category, tax_review, excluded, updated_at, remote_id, locally_modified FROM transactions ORDER BY id")[0].values;
    expect(after).toEqual(before);
    expect(db.exec("SELECT currency, direction, validation_status, category_source FROM transactions ORDER BY id")[0].values).toEqual([["EUR", "debit", "legacy", "user"], ["EUR", "credit", "legacy", "legacy"]]);
    expect(db.exec("SELECT source_sha256 FROM statements")[0].values).toEqual([["b".repeat(64)]]);
    const store = new FinanceStore(sqljsDriver(db));
    expect((await store.statements())[0]).toMatchObject({ filename: "old.csv", closingBalanceCents: 5000 });
  });
});

describe("universal import into the local database", () => {
  it("previews, then commits atomically with canonical fields, and refuses the same file again", async () => {
    const { store, db } = await newStore();
    const bytes = fixtureBytes("basic-amount.csv");
    const draft = await importDraftFile(store, bytes, "basic-amount.csv", "USD");
    expect(draft.needs).toEqual([]);
    expect(draft.summary).toMatchObject({ total: 9, valid: 9, undecided: 0 });
    // Nothing is written by previewing.
    expect(await store.transactions()).toEqual([]);
    const result = await confirmAll(store, draft);
    expect(result).toMatchObject({ transactions: 9 });
    const rows = db.exec("SELECT description, amount_cents, currency, direction, validation_status, source_ref, parse_confidence FROM transactions ORDER BY id")[0].values;
    expect(rows[0]).toEqual(["ACME CORP PAYROLL", 250000, "USD", "credit", "verified", "row:2", 100]);
    const [statement] = await store.statements();
    expect(statement).toMatchObject({ closingBalanceCents: 344865, transactionCount: 9 });
    expect(db.exec("SELECT COUNT(*) FROM import_staging_rows")[0].values[0][0]).toBe(0);
    await expect(importDraftFile(store, bytes, "copy.csv", "USD")).rejects.toMatchObject({ code: "file_duplicate" });
  });

  it("produces exactly the same stored values as the legacy CSV importer (no regression in totals)", async () => {
    const { importFile } = await import("../src/services/importFile");
    const legacy = await newStore();
    await importFile(legacy.store, fixtureBytes("basic-amount.csv"), "basic-amount.csv", "USD");
    const universal = await newStore();
    await confirmAll(universal.store, await importDraftFile(universal.store, fixtureBytes("basic-amount.csv"), "basic-amount.csv", "USD"));
    const pick = (list: Awaited<ReturnType<FinanceStore["transactions"]>>) => list.map(({ bookedOn, description, amountCents, category, taxReview, excluded }) => ({ bookedOn, description, amountCents, category, taxReview, excluded }));
    expect(pick(await universal.store.transactions())).toEqual(pick(await legacy.store.transactions()));
    const period = { preset: "all_time" as const, startDate: null, endDate: null };
    const snapshot = async (store: FinanceStore) => buildSnapshot({ transactions: await store.transactions(), statements: await store.statements(), currency: "USD", period });
    const [a, b] = await Promise.all([snapshot(legacy.store), snapshot(universal.store)]);
    expect({ ...b, recentTransactions: [] }).toEqual({ ...a, recentTransactions: [] });
  });

  it("an overlapping second statement adds only the new rows after the person confirms duplicates", async () => {
    const { store } = await newStore();
    const january = "Date,Description,Amount\n2026-01-05,Coffee,-4.00\n2026-01-05,Coffee,-4.00\n2026-01-20,Rent,-1000.00\n";
    await confirmAll(store, await importDraftFile(store, enc(january), "jan.csv", "USD"));
    const overlap = "Date,Description,Amount\n2026-01-05,Coffee,-4.00\n2026-01-05,Coffee,-4.00\n2026-01-20,Rent,-1000.00\n2026-02-01,Salary,3000.00\n2026-02-01,Coffee,-4.00\n";
    const draft = await importDraftFile(store, enc(overlap), "jan-feb.csv", "USD");
    expect(draft.summary).toMatchObject({ duplicates: 3, undecided: 3 });
    await expect(confirmAll(store, draft)).rejects.toMatchObject({ code: "blocked" });
    const decided = reviseDraft(draft, { decisions: Object.fromEntries(draft.rows.filter((row) => row.status === "needs_review").map((row) => [row.id, "skip"])) }, await importContext(store));
    const result = await confirmAll(store, decided);
    expect(result.transactions).toBe(2);
    expect((await store.transactions()).length).toBe(5);
    const history = await store.importHistory();
    expect(history[0].reports[0]).toMatchObject({ totalRows: 5, accepted: 2, skippedDuplicates: 3 });
  });

  it("leaves no trace when a write fails part-way (staging) or the row count does not match (trigger)", async () => {
    const { store: probe, db } = await newStore();
    const real = sqljsDriver(db);
    let calls = 0;
    const flaky: SqlDriver = {
      select: real.select,
      execute: async (sql, params) => {
        if (/INSERT INTO import_staging_rows/.test(sql) && ++calls === 2) throw new Error("disk full");
        return real.execute(sql, params);
      },
    };
    const store = new FinanceStore(flaky);
    const many = `Date,Description,Amount\n${Array.from({ length: 120 }, (_, i) => `2026-01-${String((i % 28) + 1).padStart(2, "0")},Item ${i},-1.00`).join("\n")}\n`;
    const draft = await importDraftFile(store, enc(many), "many.csv", "USD");
    await expect(confirmAll(store, draft)).rejects.toThrow("disk full");
    expect(await probe.statements()).toEqual([]);
    expect(await probe.transactions()).toEqual([]);
    expect(db.exec("SELECT COUNT(*) FROM import_staging_rows")[0].values[0][0]).toBe(0);
    expect(await probe.currency()).toBeNull();
    // A statement whose staged rows are incomplete is refused by the trigger as a whole.
    db.run("INSERT INTO import_staging_rows (staging_key, position, booked_on, description, amount_cents, category, tax_review, currency, direction, category_source, pending, validation_status, staged_at) VALUES ('c', 0, '2026-01-01', 'x', -1, 'Uncategorized', 0, 'USD', 'debit', 'auto', 0, 'verified', ?)", [new Date().toISOString()]);
    expect(() => db.run("INSERT INTO statements (filename, currency, sha256, transaction_count, imported_at, import_batch_id) VALUES ('x', 'USD', 'c', 2, 'now', 'b')")).toThrow(/import_incomplete/);
    expect(db.exec("SELECT COUNT(*) FROM statements")[0].values[0][0]).toBe(0);
    // Retrying the same import afterwards works (idempotent and safe to retry).
    const retry = await importDraftFile(probe, enc(many), "many.csv", "USD");
    expect((await confirmAll(probe, retry)).transactions).toBe(120);
  });

  it("commits a multi-account OFX file as separate statements and reverses the whole import only", async () => {
    const { store } = await newStore();
    await confirmAll(store, await importDraftFile(store, enc("Date,Description,Amount\n2026-02-01,Unrelated,-1.00\n"), "other.csv", "USD"));
    const ofx = `OFXHEADER:100\nDATA:OFXSGML\n\n<OFX><BANKMSGSRSV1>
<STMTTRNRS><STMTRS><CURDEF>USD<BANKACCTFROM><BANKID>9<ACCTID>98761111<ACCTTYPE>CHECKING</BANKACCTFROM><BANKTRANLIST>
<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20260301<TRNAMT>-10.00<FITID>X1<NAME>SHOP</STMTTRN></BANKTRANLIST></STMTRS></STMTTRNRS>
<STMTTRNRS><STMTRS><CURDEF>USD<BANKACCTFROM><BANKID>9<ACCTID>98762222<ACCTTYPE>SAVINGS</BANKACCTFROM><BANKTRANLIST>
<STMTTRN><TRNTYPE>INT<DTPOSTED>20260331<TRNAMT>0.42<FITID>Y1<NAME>INTEREST</STMTTRN></BANKTRANLIST></STMTRS></STMTTRNRS>
</BANKMSGSRSV1></OFX>`;
    const result = await confirmAll(store, await importDraftFile(store, enc(ofx), "bank.ofx", "USD"));
    expect(result.statementIds).toHaveLength(2);
    expect((await store.statements()).map((statement) => statement.filename)).toEqual(["other.csv", "bank.ofx", "bank.ofx"]);
    const history = await store.importHistory();
    expect(history[0]).toMatchObject({ filename: "bank.ofx", format: "ofx", transactionCount: 2 });
    expect(history[0].accounts.map((account) => account.slice(-5)).sort()).toEqual(["…1111", "…2222"]);
    // Importing the same file again is refused even though each statement has its own hash.
    await expect(importDraftFile(store, enc(ofx), "again.ofx", "USD")).rejects.toMatchObject({ code: "file_duplicate" });
    expect(await store.reverseImport(history[0].statementIds)).toBe(2);
    expect((await store.transactions()).map((transaction) => transaction.description)).toEqual(["Unrelated"]);
  });

  it("saves a template from a corrected mapping and applies it to the next export", async () => {
    const { store } = await newStore();
    const csv = "Datum;Text;Belopp\n2026-03-01;ICA;-125,50\n";
    const first = await importDraftFile(store, enc(csv), "a.csv", "EUR");
    expect(first.needs).toContain("mapping");
    const context = await importContext(store);
    const withHeader = reviseDraft(first, { headerRow: 0 }, context);
    const mapped = reviseDraft(withHeader, { mapping: { transactionDate: 0, description: 1, amount: 2 }, conventions: { decimal: ",", currency: "EUR" } }, context);
    expect(mapped.needs).toEqual([]);
    await store.saveTemplate(templateFrom({ id: "t", name: "My bank", institution: null, headers: mapped.headers, mapping: mapped.mapping, conventions: mapped.conventions, now: "2026-03-02T00:00:00Z" }));
    await confirmAll(store, mapped);
    const next = await importDraftFile(store, enc("Datum;Text;Belopp\n2026-04-01;Coop;-9,90\n"), "b.csv", "EUR");
    expect(next.templateMatch.status).toBe("matched");
    expect(next.needs).toEqual([]);
    expect(next.rows[0].amountMinor).toBe(-990);
    await store.deleteAllData();
    expect(await store.templates()).toEqual([]);
  });

  it("keeps a person's category correction authoritative when it is saved", async () => {
    const { store, db } = await newStore();
    const draft = await importDraftFile(store, enc("Date,Description,Amount\n2026-03-01,STARBUCKS,-5.00\n"), "c.csv", "USD");
    const edited = reviseDraft(draft, { edits: { [draft.rows[0].id]: { category: "Business" } } }, await importContext(store));
    await confirmAll(store, edited);
    expect(db.exec("SELECT category, category_source, validation_status, tax_review FROM transactions")[0].values).toEqual([["Business", "user", "user_confirmed", 1]]);
  });

  it("stores only currencies the database can hold exactly", () => {
    expect(CURRENCIES).not.toContain("KWD");
  });

  it("does not let the interface language change stored values", async () => {
    const results: unknown[] = [];
    for (const locale of ["en", "zh-CN", "zh-TW"]) {
      const { store, db } = await newStore();
      localStorage.setItem("billie.locale", locale);
      await confirmAll(store, await importDraftFile(store, enc("交易日期,摘要,金额\n2026-03-01,星巴克 上海,-30.00\n"), "cn.csv", "CNY"));
      results.push(db.exec("SELECT booked_on, description, amount_cents, currency FROM transactions")[0].values);
    }
    expect(results[1]).toEqual(results[0]);
    expect(results[2]).toEqual(results[0]);
    expect(results[0]).toEqual([["2026-03-01", "星巴克 上海", -3000, "CNY"]]);
  });

  it("refuses a plan in another currency than the database's", async () => {
    const { store } = await newStore();
    await confirmAll(store, await importDraftFile(store, enc("Date,Description,Amount\n2026-03-01,x,-1.00\n"), "usd.csv", "USD"));
    const eur = await importDraftFile(store, enc("Date,Description,Amount,Currency\n2026-03-01,y,-1.00,EUR\n"), "eur.csv", "USD");
    expect(commitPlan(eur, await importContext(store))).toMatchObject({ ok: false, blockers: [{ code: "currency_mismatch_device" }] });
    expect(await statementHashes([])).toEqual([]);
  });
});

describe("large files and repeated imports", () => {
  it("previews and commits 20,000 rows, then refuses the same file and dedupes an overlapping one, within time", async () => {
    const { store } = await newStore();
    const line = (i: number) => `2025-${String((i % 12) + 1).padStart(2, "0")}-${String((i % 28) + 1).padStart(2, "0")},Merchant ${i % 500},-${(i % 9000) + 1}.${String(i % 100).padStart(2, "0")}`;
    const big = `Date,Description,Amount\n${Array.from({ length: 19_999 }, (_, i) => line(i)).join("\n")}\n`;
    const started = performance.now();
    const draft = await importDraftFile(store, enc(big), "big.csv", "USD");
    expect(draft.summary.total).toBe(19_999);
    const result = await confirmAll(store, draft);
    expect(result.transactions).toBe(19_999);
    await expect(importDraftFile(store, enc(big), "big-again.csv", "USD")).rejects.toMatchObject({ code: "file_duplicate" });
    const overlap = await importDraftFile(store, enc(`Date,Description,Amount\n${line(5)}\n${line(6)}\n2026-01-01,New one,-1.00\n`), "overlap.csv", "USD");
    expect(overlap.summary).toMatchObject({ duplicates: 2, valid: 1 });
    expect(performance.now() - started).toBeLessThan(30_000);
  }, 60_000);
});

describe("OCR failures leave the database untouched", () => {
  it("an engine that throws, is cancelled or reads nothing creates no rows, statements or staging entries", async () => {
    const { registerOcrEngine } = await import("../src/services/ocrEngine");
    const { store, db } = await newStore();
    await confirmAll(store, await importDraftFile(store, enc("Date,Description,Amount\n2026-01-02,Existing,-3.00\n"), "existing.csv", "USD"));
    const snapshot = () => ["statements", "transactions", "import_staging_rows", "settings", "merchant_rules"].map((table) => db.exec(`SELECT * FROM ${table}`)[0]?.values ?? []);
    const before = JSON.stringify(snapshot());
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 10, 0, 0, 0, 10]);
    const empty = { engine: { id: "test", version: "1" }, languages: ["en"], pages: [], unsupported: [] };
    const engines = [
      { recognize: async () => { throw new Error("engine crashed"); } },
      { recognize: async () => ({ ...empty, errors: [{ page: 1, code: "cancelled" as const, message: "" }] }) },
      { recognize: async () => ({ ...empty, errors: [{ page: 1, code: "decode_failed" as const, message: "" }] }) },
      { recognize: async () => ({ ...empty, pages: [{ page: 1, width: 10, height: 10, rotation: 0 as const, lines: [] }], errors: [] }) },
    ];
    const codes: string[] = [];
    try {
      for (const engine of engines) {
        registerOcrEngine({ info: { id: "test", location: "device", languages: ["en"] }, ...engine });
        await importDraftFile(store, png, "photo.png", "USD").then(() => codes.push("ok"), (error: { code?: string }) => codes.push(String(error.code)));
      }
    } finally {
      registerOcrEngine(null);
    }
    expect(codes).toEqual(["ocr_failed", "ocr_cancelled", "ocr_failed", "ocr_failed"]);
    expect(JSON.stringify(snapshot())).toBe(before);
  });
});
