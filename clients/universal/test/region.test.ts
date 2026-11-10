// @vitest-environment jsdom
// Optional Country / Region on import: stored with the statement on the device, used only as
// extra context for rule-based categorization, editable later with an explicit reclassify.
// Real SQLite migrations (sql.js). Synthetic data only.
import initSqlJs from "sql.js";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildSnapshot } from "@billie/finance-core";
import { fixtureBytes, FIXTURES, makePdf, migrate, newStore } from "./helpers";
import { sqljsDriver } from "../src/services/sqljsDriver";
import { FinanceStore, StoreError } from "../src/services/store";
import { importFile } from "../src/services/importFile";
import { commitDraft, importContext, importDraftFile } from "../src/services/universalImport";
import { uploadStatement } from "../src/services/cloudUpload";
import { REPORT_FIELDS } from "../src/services/localReport";

const enc = (text: string) => new TextEncoder().encode(text);

// A small statement mixing US, Chinese and UK descriptions (amounts in USD, money out negative).
const MIXED = enc([
  "Date,Description,Amount",
  "2026-03-01,ACME CORP PAYROLL,2500.00",
  "2026-03-02,ZELLE PAYMENT TO J SMITH,-40.00",
  "2026-03-03,支付宝-美团外卖订单,-12.30",
  "2026-03-04,TESCO STORES 3021,-25.10",
  "2026-03-05,STARBUCKS STORE #1234,-5.75",
  "2026-03-06,MYSTERY VENDOR 99,-9.99",
].join("\n"));

/** Previews a file with the region chosen on the Import page, then confirms it as the page does. */
async function importWithRegion(store: FinanceStore, bytes: Uint8Array, filename: string, region: string | null) {
  const draft = await importDraftFile(store, bytes, filename, "USD", undefined, region);
  return commitDraft(store, draft, await importContext(store, region));
}

const byDescription = async (store: FinanceStore) => Object.fromEntries((await store.transactions()).map((t) => [t.description, t.category]));
const financial = async (store: FinanceStore) => ({
  transactions: (await store.transactions()).map(({ id, statementId, bookedOn, description, amountCents, excluded }) => ({ id, statementId, bookedOn, description, amountCents, excluded })),
  statements: (await store.statements()).map(({ region, ...rest }) => rest),
  currency: await store.currency(),
});

describe("1. importing without a region works exactly as before", () => {
  it("universal import: same categories and statement as with no region argument at all", async () => {
    const plain = await newStore();
    await commitDraft(plain.store, await importDraftFile(plain.store, MIXED, "m.csv", "USD"), await importContext(plain.store));
    const none = await newStore();
    await importWithRegion(none.store, MIXED, "m.csv", null);
    expect(await byDescription(none.store)).toEqual(await byDescription(plain.store));
    expect((await none.store.statements())[0].region).toBeNull();
    expect(none.db.exec("SELECT DISTINCT category_source FROM transactions")[0].values.flat()).toEqual(["auto"]);
  });

  it("legacy path: stores exactly the Ruby-generated expected rows", async () => {
    const { store } = await newStore();
    await importFile(store, fixtureBytes("debit-credit-newest-first.csv"), "d.csv", "USD", null);
    const expected = JSON.parse(readFileSync(join(FIXTURES, "expected/debit-credit-newest-first.json"), "utf8"));
    expect((await store.transactions()).sort((a, b) => a.id - b.id).map(({ id, statementId, ...rest }) => rest)).toEqual(expected.rows);
  });
});

describe("2. the selected region is saved as statement metadata", () => {
  it("universal import (CSV): region on the statement and in Import history", async () => {
    const { store } = await newStore();
    await importWithRegion(store, MIXED, "m.csv", "CN");
    expect((await store.statements())[0].region).toBe("CN");
    expect((await store.importHistory())[0]).toMatchObject({ filename: "m.csv", region: "CN" });
  });

  it("text PDF (imported without review) keeps the region too", async () => {
    const { store } = await newStore();
    const pdf = makePdf([[
      "Sample Bank UK",
      "Statement period: October 1, 2025 through October 31, 2025",
      [[50, "Date"], [120, "Description"], [420, "Amount"]],
      [[50, "10/02"], [120, "Salary ACME Ltd"], [420, "+2,400.00"]],
      [[50, "10/05"], [120, "TESCO STORES 3021"], [420, "-86.35"]],
      [[50, "Ending balance"], [420, "2,313.65"]],
    ]]);
    const result = await importFile(store, pdf, "uk.pdf", "USD", "GB");
    expect(result).toMatchObject({ kind: "imported", format: "pdf" });
    expect((await store.statements())[0].region).toBe("GB");
    expect(await byDescription(store)).toMatchObject({ "TESCO STORES 3021": "Food & dining" });
  });

  it("an unknown code is never stored", async () => {
    const { store } = await newStore();
    await importWithRegion(store, MIXED, "m.csv", "ZZ");
    expect((await store.statements())[0].region).toBeNull();
    await expect(store.setStatementRegion([(await store.statements())[0].id], "ZZ")).rejects.toMatchObject({ code: "invalid_region" });
  });
});

describe("3. regional rules improve recognition", () => {
  it.each([
    ["US", { "ZELLE PAYMENT TO J SMITH": "Transfers", "支付宝-美团外卖订单": "Uncategorized", "TESCO STORES 3021": "Uncategorized" }],
    ["CN", { "ZELLE PAYMENT TO J SMITH": "Uncategorized", "支付宝-美团外卖订单": "Food & dining", "TESCO STORES 3021": "Uncategorized" }],
    ["GB", { "ZELLE PAYMENT TO J SMITH": "Uncategorized", "支付宝-美团外卖订单": "Uncategorized", "TESCO STORES 3021": "Food & dining" }],
  ])("%s", async (region, expected) => {
    const { store, db } = await newStore();
    await importWithRegion(store, MIXED, "m.csv", region);
    const categories = await byDescription(store);
    expect(categories).toMatchObject(expected);
    // Everything the general rules decide is the same in every region.
    expect(categories).toMatchObject({ "ACME CORP PAYROLL": "Income", "STARBUCKS STORE #1234": "Food & dining", "MYSTERY VENDOR 99": "Uncategorized" });
    // Rows only the region decided are marked so a reclassification can revisit them.
    const marked = db.exec("SELECT description FROM transactions WHERE category_source = 'region'")[0].values.flat();
    expect(marked).toEqual(Object.entries(expected).filter(([, category]) => category !== "Uncategorized").map(([description]) => description));
  });

  it("the region does not choose the currency", async () => {
    const { store } = await newStore();
    const draft = await importDraftFile(store, MIXED, "m.csv", "USD", undefined, "CN");
    expect(draft.effective.currency).toBe("USD");
    await commitDraft(store, draft, await importContext(store, "CN"));
    expect(await store.currency()).toBe("USD");
    expect((await store.statements())[0].currency).toBe("USD");
  });
});

describe("4. a person's own choices take precedence", () => {
  it("corrections, remembered rules and preview edits are kept when the region changes and is reclassified", async () => {
    const { store } = await newStore();
    // A remembered rule from an earlier correction: this merchant is Housing for this person.
    const earlier = enc("Date,Description,Amount\n2026-02-01,ZELLE PAYMENT TO J SMITH,-40.00\n");
    await importWithRegion(store, earlier, "feb.csv", null);
    const [feb] = await store.transactions();
    await store.setCategory(feb.id, "Housing", true);

    // Preview edit: the person picks Shopping for the Tesco row before confirming.
    const draft = await importDraftFile(store, MIXED, "m.csv", "USD", undefined, "GB");
    const tesco = draft.rows.find((row) => row.originalDescription === "TESCO STORES 3021")!;
    const { reviseDraft } = await import("@billie/finance-core");
    const context = await importContext(store, "GB");
    const edited = reviseDraft(draft, { edits: { ...draft.edits, [tesco.id]: { category: "Shopping" } } }, context);
    await commitDraft(store, edited, context);
    const march = (await store.statements()).find((s) => s.filename === "m.csv")!;

    let categories = await byDescription(store);
    expect(categories["ZELLE PAYMENT TO J SMITH"]).toBe("Housing"); // remembered rule beat the US/region rules
    expect(categories["TESCO STORES 3021"]).toBe("Shopping"); // preview edit beat the GB rule

    // A correction after import.
    const mystery = (await store.transactions()).find((t) => t.description === "MYSTERY VENDOR 99")!;
    await store.setCategory(mystery.id, "Business", false);

    for (const region of ["US", "CN", null, "GB"]) {
      await store.setStatementRegion([march.id], region);
      await store.reclassifyStatements([march.id]);
      categories = await byDescription(store);
      expect(categories["ZELLE PAYMENT TO J SMITH"]).toBe("Housing");
      expect(categories["TESCO STORES 3021"]).toBe("Shopping");
      expect(categories["MYSTERY VENDOR 99"]).toBe("Business");
    }
  });

  it("a category chosen with AI is not reclassified, even where the region has a rule", async () => {
    const { store } = await newStore();
    await importWithRegion(store, MIXED, "m.csv", null);
    const meituan = (await store.transactions()).find((t) => t.description === "支付宝-美团外卖订单")!;
    const groups = await store.aiCandidates();
    const group = groups.find((candidate) => candidate.ids.includes(meituan.id))!;
    expect(await store.applyAiCategories(groups, [{ key: group.key, category: "Shopping" }])).toBe(1);
    const [statement] = await store.statements();
    await store.setStatementRegion([statement.id], "CN");
    await store.reclassifyStatements([statement.id]);
    expect((await byDescription(store))["支付宝-美团外卖订单"]).toBe("Shopping"); // the CN rule would say Food & dining
  });
});

describe("5. changing the region never changes financial data", () => {
  it("saving the region changes no category; reclassifying changes categories only", async () => {
    const { store } = await newStore();
    await importWithRegion(store, MIXED, "m.csv", "US");
    const [statement] = await store.statements();
    const before = await financial(store);
    const categoriesBefore = await byDescription(store);
    const totalsBefore = buildSnapshot({ transactions: await store.transactions(), statements: await store.statements(), period: { startDate: null, endDate: null }, currency: "USD" });

    await store.setStatementRegion([statement.id], "CN");
    expect(await byDescription(store)).toEqual(categoriesBefore); // metadata only, nothing silently reclassified
    expect((await store.statements())[0].region).toBe("CN");

    expect(await store.reclassifyStatements([statement.id])).toBe(2); // Zelle → Uncategorized, Meituan → Food
    expect(await financial(store)).toEqual(before);
    const categories = await byDescription(store);
    expect(categories).toMatchObject({ "ZELLE PAYMENT TO J SMITH": "Uncategorized", "支付宝-美团外卖订单": "Food & dining" });
    const totals = buildSnapshot({ transactions: await store.transactions(), statements: await store.statements(), period: { startDate: null, endDate: null }, currency: "USD" });
    expect([totals.incomeCents, totals.balanceCents, totals.transactionCount]).toEqual([totalsBefore.incomeCents, totalsBefore.balanceCents, totalsBefore.transactionCount]);

    // Reclassifying again is a no-op.
    expect(await store.reclassifyStatements([statement.id])).toBe(0);
  });

  it("website copies cannot be given a region or reclassified here", async () => {
    const { store } = await newStore();
    await store.applyWebData({
      currency: "USD", rules: [],
      statements: [{ remoteId: 7, filename: "web.csv", currency: "USD", sha256: "c".repeat(64), transactionCount: 1, closingBalanceCents: null, closingBalanceOn: null, importedAt: "2026-01-01T00:00:00Z" }],
      transactions: [{ remoteId: 70, remoteStatementId: 7, bookedOn: "2026-01-02", description: "ZELLE TO A", amountCents: -100, category: "Uncategorized", taxReview: false, excluded: false }],
    });
    const [web] = await store.statements();
    await expect(store.setStatementRegion([web.id], "US")).rejects.toBeInstanceOf(StoreError);
    await expect(store.reclassifyStatements([web.id])).rejects.toBeInstanceOf(StoreError);
  });
});

describe("6. statements imported before this version", () => {
  it("migration 5 keeps every row; old statements read as Not specified and can be given a region later", async () => {
    const SQL = await initSqlJs();
    const db = new SQL.Database();
    migrate(db, 4);
    // Rows as an app version without regions wrote them.
    db.run("INSERT INTO statements (id, filename, currency, sha256, transaction_count, imported_at, source_sha256) VALUES (1, 'old.csv', 'USD', ?, 2, '2026-01-04T00:00:00Z', ?)", ["d".repeat(64), "d".repeat(64)]);
    db.run(`INSERT INTO transactions (statement_id, booked_on, description, amount_cents, category, tax_review, excluded, updated_at, category_source) VALUES
      (1, '2026-01-02', '支付宝-美团外卖订单', -1230, 'Uncategorized', 0, 0, 'x', 'auto'), (1, '2026-01-03', 'ZELLE PAYMENT TO J SMITH', -4000, 'Uncategorized', 0, 0, 'x', 'legacy')`);
    const columns = "id, statement_id, booked_on, description, amount_cents, category, tax_review, excluded, category_source";
    const before = db.exec(`SELECT ${columns} FROM transactions ORDER BY id`)[0].values;
    const statementBefore = db.exec("SELECT * FROM statements")[0].values;
    migrate(db);
    expect(db.exec(`SELECT ${columns} FROM transactions ORDER BY id`)[0].values).toEqual(before);
    // Version 5 adds region; version 6 adds region_source, detected_region, region_confidence, region_evidence. All empty.
    expect(db.exec("SELECT * FROM statements")[0].values).toEqual([[...statementBefore[0], null, null, null, null, null]]);

    const store = new FinanceStore(sqljsDriver(db));
    const [statement] = await store.statements();
    expect(statement.region).toBeNull();
    expect((await store.importHistory())[0].region).toBeNull();
    await store.setStatementRegion([statement.id], "CN");
    expect(await store.reclassifyStatements([statement.id])).toBe(1);
    expect(await byDescription(store)).toMatchObject({ "支付宝-美团外卖订单": "Food & dining", "ZELLE PAYMENT TO J SMITH": "Uncategorized" });
  });
});

describe("7. duplicates", () => {
  it("re-importing the same file, with the same or another region, adds nothing", async () => {
    const { store } = await newStore();
    await importWithRegion(store, MIXED, "m.csv", "US");
    const count = (await store.transactions()).length;
    for (const region of ["US", "CN", null]) {
      await expect(importWithRegion(store, MIXED, "again.csv", region)).rejects.toMatchObject({ code: expect.stringMatching(/duplicate|already/) });
      await expect(importFile(store, MIXED, "again.csv", "USD", region)).rejects.toMatchObject({ code: "statement_duplicate" });
    }
    expect((await store.transactions()).length).toBe(count);
    expect((await store.statements()).length).toBe(1);
  });
});

describe("8. no region or financial data is uploaded unintentionally", () => {
  it("nothing in the region feature uses the network", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const { store } = await newStore();
    await importWithRegion(store, MIXED, "m.csv", "CN");
    const [statement] = await store.statements();
    await store.setStatementRegion([statement.id], "US");
    await store.reclassifyStatements([statement.id]);
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("an explicit cloud sync sends the same fields as before: no region", async () => {
    const { store } = await newStore();
    await importWithRegion(store, MIXED, "m.csv", "CN");
    const data = await store.exportData();
    expect(data.statements[0].region).toBe("CN");
    const bodies: string[] = [];
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      bodies.push(String(init?.body));
      return new Response(JSON.stringify({ id: 1, created: true }), { status: 201 });
    });
    await uploadStatement("tok", data.statements[0]);
    fetchSpy.mockRestore();
    const sent = JSON.parse(bodies[0]);
    expect(Object.keys(sent.statement).sort()).toEqual(["closing_balance", "closing_balance_on", "currency", "filename", "sha256", "transactions"]);
    expect(bodies[0]).not.toMatch(/region|"CN"/);
  });

  it("local database metadata reports never include the region", () => {
    expect(REPORT_FIELDS as readonly string[]).not.toContain("region");
    expect(readFileSync(join(__dirname, "../src/services/localReport.ts"), "utf8")).not.toMatch(/region/i);
  });

  it("a local → local sync keeps the region on the device", async () => {
    const source = await newStore();
    await importWithRegion(source.store, MIXED, "m.csv", "GB");
    const target = await newStore();
    await target.store.mergeData(await source.store.exportData());
    expect((await target.store.statements())[0].region).toBe("GB");
  });
});
