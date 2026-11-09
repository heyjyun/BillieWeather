import { decodeStatementBytes, parseStatement, sha256Hex, buildSnapshot } from "@billie/finance-core";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fixtureBytes, migrate, newStore, FIXTURES } from "./helpers";
import { StoreError } from "../src/services/store";
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

  it("re-running migrations keeps existing data", async () => {
    const { db, store } = await newStore();
    await importFile(store, fixtureBytes("basic-amount.csv"), "b.csv", "USD");
    migrate(db);
    expect((await store.transactions()).length).toBe(9);
  });

  it("the database refuses invalid categories", async () => {
    const { db } = await newStore();
    db.run("INSERT INTO statements (filename, currency, sha256, transaction_count, imported_at) VALUES ('a','USD','x',0,'t')");
    expect(() => db.run("INSERT INTO transactions (statement_id, booked_on, description, amount_cents, category, updated_at) VALUES (1,'2026-01-01','d',1,'Crypto','t')")).toThrow();
  });

  it("rolls back a statement whose rows fail to insert", async () => {
    const { store } = await newStore();
    const bytes = fixtureBytes("basic-amount.csv");
    const parsed = parseStatement(decodeStatementBytes(bytes, "b.csv"), { filename: "b.csv", currency: "USD", categorizer: await store.categorizer() });
    parsed.rows[3] = { ...parsed.rows[3], category: "Bogus" as never };
    await expect(store.importStatement({ filename: "b.csv", currency: "USD", sha256: await sha256Hex(bytes), parsed })).rejects.toThrow();
    expect(await store.statements()).toEqual([]);
    expect(await store.transactions()).toEqual([]);
  });
});
