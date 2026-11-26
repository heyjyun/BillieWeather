// Agent A repro tests (Phase 1, read-only audit). Synthetic data only, in-memory sql.js.
// Run with the config next to this file (see findings.md section E). They assert the CURRENT behavior,
// so a passing test here CONFIRMS the defect; the proposed regression tests invert these assertions.
import initSqlJs from "sql.js";
import { migrate } from "../../../../../../clients/universal/test/helpers";
import { sqljsDriver } from "../../../../../../clients/universal/src/services/sqljsDriver";
import { FinanceStore, type SqlDriver, type WebData } from "../../../../../../clients/universal/src/services/store";
import { importFile } from "../../../../../../clients/universal/src/services/importFile";

async function fresh(wrap: (driver: SqlDriver) => SqlDriver = (d) => d) {
  const SQL = await initSqlJs();
  const db = new SQL.Database();
  migrate(db);
  return { db, store: new FinanceStore(wrap(sqljsDriver(db))) };
}

const count = (db: { exec: (sql: string) => Array<{ values: unknown[][] }> }, sql: string) => Number(db.exec(sql)[0]?.values[0][0] ?? 0);

describe("A-04: a website download is not row-deduplicated against local imports of another file", () => {
  it("the same purchase imported locally (CSV) and present on the website under another file hash is stored twice", async () => {
    const { db, store } = await fresh();
    const csv = new TextEncoder().encode("Date,Description,Amount\n2026-03-02,SYNTH COFFEE BAR,-4.50\n2026-03-03,SYNTH GROCER,-20.00\n");
    await importFile(store, csv, "local-march.csv", "USD");
    const web: WebData = {
      currency: "USD",
      statements: [{ remoteId: 501, filename: "march.pdf", currency: "USD", sha256: "f".repeat(64), transactionCount: 2, closingBalanceCents: null, closingBalanceOn: null, importedAt: "2026-04-01T00:00:00Z" }],
      transactions: [
        { remoteId: 9001, remoteStatementId: 501, bookedOn: "2026-03-02", description: "SYNTH COFFEE BAR", amountCents: -450, category: "Food & dining", taxReview: false, excluded: false },
        { remoteId: 9002, remoteStatementId: 501, bookedOn: "2026-03-03", description: "SYNTH GROCER", amountCents: -2000, category: "Groceries", taxReview: false, excluded: false },
      ],
      rules: [],
    };
    const result = await store.applyWebData(web);
    expect(result).toMatchObject({ statementsAdded: 1, transactionsAdded: 2, skippedDuplicates: 0 });
    // CURRENT behavior: both copies are live and both count as spending.
    expect(count(db, "SELECT COUNT(*) FROM transactions WHERE description = 'SYNTH COFFEE BAR' AND deleted_at IS NULL")).toBe(2);
    expect(count(db, "SELECT -SUM(amount_cents) FROM transactions WHERE deleted_at IS NULL AND kind = 'expense'")).toBe(4900);
  });
});

describe("A-05: a local import that fails at commit leaves the account it created outside the transaction", () => {
  it("an identified-account import whose transaction is refused (SQLITE_BUSY at commit) still leaves a new account and audit row", async () => {
    let failNext = false;
    const { db, store } = await fresh((driver) => ({
      ...driver,
      transaction: async (statements) => {
        // The import's own batch starts with the currency guard; fail only that batch.
        if (failNext && statements.some((s) => s.sql.includes("INSERT INTO statements"))) throw new Error("database is locked (code: 5)");
        return driver.transaction(statements);
      },
    }));
    expect(await store.hasContent()).toBe(false);
    failNext = true;
    await expect(store.importStatement({
      filename: "card.csv", currency: "USD", sha256: "a".repeat(64),
      parsed: { rows: [{ bookedOn: "2026-03-02", description: "SYNTH SHOP", amountCents: -1000, category: "Shopping", taxReview: false, excluded: false }], closingBalanceCents: null, closingBalanceOn: null, dateColumnUsed: null },
      account: { key: "synthbank:1234:credit_card", institution: "Synth Bank", last4: "1234", kind: "credit_card", country: null },
    })).rejects.toThrow(/locked/);
    // Nothing was imported…
    expect(count(db, "SELECT COUNT(*) FROM statements")).toBe(0);
    expect(count(db, "SELECT COUNT(*) FROM transactions")).toBe(0);
    // …but the account (and its append-only audit row) was committed separately.
    expect(count(db, "SELECT COUNT(*) FROM accounts WHERE account_key = 'synthbank:1234:credit_card'")).toBe(1);
    expect(count(db, "SELECT COUNT(*) FROM audit_events WHERE subject_type = 'account'")).toBe(1);
    // An otherwise empty book now counts as "occupied" for slot discovery (createDatabase / claim logic).
    expect(await store.hasContent()).toBe(true);
  });
});
