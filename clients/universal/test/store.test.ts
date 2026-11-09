import { decodeStatementBytes, parseStatement, sha256Hex, buildSnapshot } from "@billie/finance-core";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fixtureBytes, migrate, newStore, FIXTURES } from "./helpers";
import { normalizeDatabaseName, StoreError } from "../src/services/store";
import { genericDeviceName } from "../src/services/platform";
import { importFile } from "../src/services/importFile";

describe("local SQLite store", () => {
  it("imports a statement, refuses the same file twice, and keeps one currency", async () => {
    const { store } = await newStore();
    const bytes = fixtureBytes("basic-amount.csv");
    const result = await importFile(store, bytes, "basic-amount.csv", "USD");
    expect(result.count).toBe(9);
    expect((await store.transactions()).length).toBe(9);
    expect(await store.currency()).toBe("USD");
    await expect(importFile(store, bytes, "copy.csv", "USD")).rejects.toThrow("already imported");
    await expect(importFile(store, fixtureBytes("type-category-symbols.csv"), "t.csv", "EUR")).rejects.toBeInstanceOf(StoreError);
    expect((await store.transactions()).length).toBe(9);
  });

  it("stores exactly what the parser produced (amounts in cents, categories, closing balance)", async () => {
    const { store } = await newStore();
    await importFile(store, fixtureBytes("debit-credit-newest-first.csv"), "d.csv", "USD");
    const expected = JSON.parse(readFileSync(join(FIXTURES, "expected/debit-credit-newest-first.json"), "utf8"));
    const stored = (await store.transactions()).sort((a, b) => a.id - b.id).map(({ id, statementId, ...rest }) => rest);
    expect(stored).toEqual(expected.rows);
    const [statement] = await store.statements();
    expect([statement.closingBalanceCents, statement.closingBalanceOn]).toEqual([expected.closingBalanceCents, expected.closingBalanceOn]);
  });

  it("matches the shared dashboard totals after importing every fixture", async () => {
    const { store } = await newStore();
    for (const name of ["basic-amount.csv", "debit-credit-newest-first.csv", "type-category-symbols.csv"]) await importFile(store, fixtureBytes(name), name, "USD");
    const snap = buildSnapshot({ transactions: await store.transactions(), statements: await store.statements(), period: { startDate: null, endDate: null }, currency: "USD" });
    const expected = JSON.parse(readFileSync(join(FIXTURES, "expected/snapshot.json"), "utf8"));
    expect([snap.incomeCents, snap.expensesCents, snap.transactionCount]).toEqual([expected.incomeCents, expected.expensesCents, expected.transactionCount]);
  });

  it("remembers a correction and applies it to the same merchant's Uncategorized rows only", async () => {
    const { store } = await newStore();
    const csv = "Date,Description,Amount\n2026-01-01,ZED BAKERS 1,-5.00\n2026-01-02,Zed Bakers 2,-6.00\n2026-01-03,ZED BAKERS REFUND,7.00\n2026-01-04,OTHER PLACE,-1.00\n";
    await importFile(store, new TextEncoder().encode(csv), "z.csv", "USD");
    const first = (await store.transactions()).find((t) => t.description === "ZED BAKERS 1")!;
    expect(await store.setCategory(first.id, "Business", true)).toBe(1);
    const byDescription = Object.fromEntries((await store.transactions()).map((t) => [t.description, t]));
    expect(byDescription["Zed Bakers 2"].category).toBe("Business");
    expect(byDescription["Zed Bakers 2"].taxReview).toBe(true);
    expect(byDescription["ZED BAKERS REFUND"].category).toBe("Income");
    expect(byDescription["OTHER PLACE"].category).toBe("Uncategorized");
    expect(await store.rules()).toEqual([{ merchantKey: "zed bakers", income: false, category: "Business" }]);

    // Later imports use the remembered rule.
    await importFile(store, new TextEncoder().encode("Date,Description,Amount\n2026-02-01,ZED BAKERS 9,-3.00\n"), "z2.csv", "USD");
    expect((await store.transactions()).find((t) => t.description === "ZED BAKERS 9")!.category).toBe("Business");

    // Without "remember", nothing else changes and no rule is saved.
    const other = byDescription["OTHER PLACE"];
    expect(await store.setCategory(other.id, "Shopping", false)).toBe(0);
    expect((await store.rules()).length).toBe(1);
  });

  it("excludes a transaction from totals", async () => {
    const { store } = await newStore();
    await importFile(store, new TextEncoder().encode("Date,Description,Amount\n2026-01-01,Coffee shop,-5.00\n"), "c.csv", "USD");
    const [row] = await store.transactions();
    await store.setExcluded(row.id, true);
    const snap = buildSnapshot({ transactions: await store.transactions(), statements: await store.statements(), period: { startDate: null, endDate: null }, currency: "USD" });
    expect(snap.expensesCents).toBe(0);
    expect(snap.excludedCount).toBe(1);
  });

  it("deletes every local record", async () => {
    const { db, store } = await newStore();
    await importFile(store, fixtureBytes("basic-amount.csv"), "b.csv", "USD");
    const first = (await store.transactions())[0];
    await store.setCategory(first.id, "Shopping", true);
    await store.deleteAllData();
    for (const table of ["transactions", "statements", "merchant_rules", "settings"]) {
      expect(db.exec(`SELECT COUNT(*) FROM ${table}`)[0].values[0][0]).toBe(0);
    }
    expect(await store.currency()).toBeNull();
    // Importing again works after deletion (the duplicate check is cleared too).
    await importFile(store, fixtureBytes("basic-amount.csv"), "b.csv", "USD");
  });

  it("names this device's database, and the name survives deleting local data", async () => {
    const { db, store } = await newStore();
    expect(await store.databaseName()).toBeNull();
    expect(await store.setDatabaseName("  Jyun's \t MacBook  Pro ")).toBe("Jyun's MacBook Pro");
    await expect(store.setDatabaseName("   ")).rejects.toBeInstanceOf(StoreError);
    expect(await store.databaseName()).toBe("Jyun's MacBook Pro");
    await importFile(store, fixtureBytes("basic-amount.csv"), "b.csv", "USD");
    await store.deleteAllData();
    expect(await store.databaseName()).toBe("Jyun's MacBook Pro");
    expect(db.exec("SELECT key FROM settings")[0].values).toEqual([["database_name"]]);
    expect([...normalizeDatabaseName("名".repeat(80))].length).toBe(60);
  });

  it("falls back to a generic device label from the WebView", () => {
    expect(genericDeviceName("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)")).toBe("iPhone");
    expect(genericDeviceName("Mozilla/5.0 (Linux; Android 15; Pixel 8)")).toBe("Android");
    expect(genericDeviceName("Mozilla/5.0 (Windows NT 10.0; Win64; x64)")).toBe("Windows PC");
    expect(genericDeviceName("curl/8")).toBeNull();
  });

  it("re-running migrations keeps existing data", async () => {
    const { db, store } = await newStore();
    await importFile(store, fixtureBytes("basic-amount.csv"), "b.csv", "USD");
    migrate(db);
    expect((await store.transactions()).length).toBe(9);
  });

  it("the database refuses unusable category names (custom names are checked by the store)", async () => {
    const { db } = await newStore();
    db.run("INSERT INTO statements (filename, currency, sha256, transaction_count, imported_at) VALUES ('a','USD','x',0,'t')");
    const insert = (category: string) => db.run("INSERT INTO transactions (statement_id, booked_on, description, amount_cents, category, updated_at) VALUES (1,'2026-01-01','d',1,?,'t')", [category]);
    expect(() => insert("")).toThrow();
    expect(() => insert("x".repeat(41))).toThrow();
    expect(() => db.run("INSERT INTO merchant_rules (merchant_key, income, category, updated_at) VALUES ('m', 0, 'Uncategorized', 't')")).toThrow();
    expect(() => insert("Crypto")).not.toThrow();
  });

  it("rolls back a statement whose rows fail to insert", async () => {
    const { store } = await newStore();
    const bytes = fixtureBytes("basic-amount.csv");
    const parsed = parseStatement(decodeStatementBytes(bytes, "b.csv"), { filename: "b.csv", currency: "USD", categorizer: await store.categorizer() });
    parsed.rows[3] = { ...parsed.rows[3], category: "" };
    await expect(store.importStatement({ filename: "b.csv", currency: "USD", sha256: await sha256Hex(bytes), parsed })).rejects.toThrow();
    expect(await store.statements()).toEqual([]);
    expect(await store.transactions()).toEqual([]);
  });
});

describe("copying data between databases", () => {
  it("copies statements, transactions and rules once, leaving the source untouched", async () => {
    const source = await newStore();
    const target = await newStore();
    await importFile(source.store, fixtureBytes("basic-amount.csv"), "basic-amount.csv", "USD");
    const [first] = await source.store.transactions();
    await source.store.setCategory(first.id, "Business", true);
    const before = await source.store.transactions();

    const data = await source.store.exportData();
    expect(data.statements.length).toBe(1);
    expect(data.statements[0].rows.length).toBe(9);
    const result = await target.store.mergeData(data);
    expect(result).toMatchObject({ statementsAdded: 1, transactionsAdded: 9, skipped: 0 });
    expect(result.rulesAdded).toBeGreaterThan(0);

    const copied = (await target.store.transactions()).map(({ id, statementId, ...rest }) => rest).sort((a, b) => a.description.localeCompare(b.description));
    const original = before.map(({ id, statementId, ...rest }) => rest).sort((a, b) => a.description.localeCompare(b.description));
    expect(copied).toEqual(original);
    expect(await target.store.currency()).toBe("USD");
    expect((await target.store.statements())[0]).toMatchObject({ sha256: data.statements[0].sha256, source: "local" });
    expect(await source.store.transactions()).toEqual(before);

    // Running it again changes nothing.
    expect(await target.store.mergeData(data)).toEqual({ statementsAdded: 0, transactionsAdded: 0, rulesAdded: 0, skipped: 1 });
    expect((await target.store.transactions()).length).toBe(9);
  });

  it("refuses to mix currencies and leaves the target as it was", async () => {
    const source = await newStore();
    const target = await newStore();
    await importFile(source.store, fixtureBytes("basic-amount.csv"), "a.csv", "USD");
    await target.store.mergeData({ rules: [], statements: [{ filename: "b.csv", currency: "EUR", sha256: "e".repeat(64), closingBalanceCents: null, closingBalanceOn: null, importedAt: "2026-01-01", rows: [{ bookedOn: "2026-01-01", description: "x", amountCents: -100, category: "Shopping", taxReview: false, excluded: false }] }] });
    await expect(target.store.mergeData(await source.store.exportData())).rejects.toBeInstanceOf(StoreError);
    expect((await target.store.statements()).length).toBe(1);
  });

  it("a statement the person removed from this database can be copied back in on purpose", async () => {
    const source = await newStore();
    const target = await newStore();
    await importFile(source.store, fixtureBytes("basic-amount.csv"), "a.csv", "USD");
    const data = await source.store.exportData();
    await target.store.mergeData(data);
    await target.store.removeStatement((await target.store.statements())[0].id);
    expect(await target.store.skippedHashes()).toContain(data.statements[0].sha256);
    expect((await target.store.mergeData(data)).statementsAdded).toBe(1);
    expect(await target.store.skippedHashes()).not.toContain(data.statements[0].sha256);
  });

  it("reports when the database last changed, and forgetting the name clears every setting", async () => {
    const { store } = await newStore();
    expect(await store.lastChanged()).toBeNull();
    await importFile(store, fixtureBytes("basic-amount.csv"), "a.csv", "USD");
    expect(await store.lastChanged()).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    await store.setDatabaseName("Work");
    await store.deleteAllData();
    expect(await store.databaseName()).toBe("Work");
    await store.deleteAllData({ forgetName: true });
    expect(await store.databaseName()).toBeNull();
    expect(await store.lastChanged()).toBeNull();
  });
});
