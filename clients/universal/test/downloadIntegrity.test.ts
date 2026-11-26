// Audit A-04 / A-05 (four-agent audit 2026-11-25): a website download never counts a row twice that a
// file imported on this device already holds, and imports/downloads that fail leave nothing behind.
// Synthetic data only.
import initSqlJs from "sql.js";
import { migrate } from "./helpers";
import { sqljsDriver } from "../src/services/sqljsDriver";
import { FinanceStore, type SqlDriver, type WebData } from "../src/services/store";
import { importFile } from "../src/services/importFile";

async function fresh(wrap: (driver: SqlDriver) => SqlDriver = (driver) => driver) {
  const SQL = await initSqlJs();
  const db = new SQL.Database();
  migrate(db);
  return { db, store: new FinanceStore(wrap(sqljsDriver(db))) };
}

const count = (db: { exec: (sql: string) => Array<{ values: unknown[][] }> }, sql: string) => Number(db.exec(sql)[0]?.values[0][0] ?? 0);

const webStatement = (rows: Array<{ id: number; on: string; text: string; cents: number }>, extra: Partial<WebData> = {}): WebData => ({
  currency: "USD",
  statements: [{ remoteId: 501, filename: "march.pdf", currency: "USD", sha256: "f".repeat(64), transactionCount: rows.length, closingBalanceCents: null, closingBalanceOn: null, importedAt: "2026-04-01T00:00:00Z" }],
  transactions: rows.map((row) => ({ remoteId: row.id, remoteStatementId: 501, bookedOn: row.on, description: row.text, amountCents: row.cents, category: "Shopping", taxReview: false, excluded: false })),
  rules: [],
  ...extra,
});

/** Fails the next batch that writes `marker` (a lock or crash at commit). */
function failing(marker: string) {
  const state = { armed: false };
  const wrap = (driver: SqlDriver): SqlDriver => ({
    ...driver,
    transaction: async (statements) => {
      if (state.armed && statements.some((statement) => statement.sql.includes(marker))) throw new Error("database is locked (code: 5)");
      return driver.transaction(statements);
    },
  });
  return { state, wrap };
}

describe("website download and rows imported on this device (A-04)", () => {
  it("does not add a website row that a local file of the same statement already holds", async () => {
    const { db, store } = await fresh();
    await importFile(store, new TextEncoder().encode("Date,Description,Amount\n2026-03-02,SYNTH COFFEE BAR,-4.50\n2026-03-03,SYNTH GROCER,-20.00\n"), "local-march.csv", "USD");
    const result = await store.applyWebData(webStatement([
      { id: 9001, on: "2026-03-02", text: "SYNTH COFFEE BAR", cents: -450 },
      { id: 9002, on: "2026-03-03", text: "SYNTH GROCER", cents: -2000 },
      { id: 9003, on: "2026-03-04", text: "SYNTH BOOKSHOP", cents: -1200 },
    ]));
    expect(result).toMatchObject({ statementsAdded: 1, transactionsAdded: 1, duplicateTransactionsSkipped: 2 });
    expect(count(db, "SELECT COUNT(*) FROM transactions WHERE description = 'SYNTH COFFEE BAR' AND deleted_at IS NULL")).toBe(1);
    expect(count(db, "SELECT -SUM(amount_cents) FROM transactions WHERE deleted_at IS NULL AND kind = 'expense'")).toBe(450 + 2000 + 1200);
    // A repeat download changes nothing.
    expect(await store.applyWebData(webStatement([
      { id: 9001, on: "2026-03-02", text: "SYNTH COFFEE BAR", cents: -450 },
      { id: 9002, on: "2026-03-03", text: "SYNTH GROCER", cents: -2000 },
      { id: 9003, on: "2026-03-04", text: "SYNTH BOOKSHOP", cents: -1200 },
    ]))).toMatchObject({ transactionsAdded: 0, transactionsRemoved: 0, duplicateTransactionsSkipped: 2 });
  });

  it("keeps genuine identical purchases beyond the ones already stored (occurrence counting)", async () => {
    const { db, store } = await fresh();
    await importFile(store, new TextEncoder().encode("Date,Description,Amount\n2026-03-02,SYNTH BUS FARE,-2.75\n"), "local.csv", "USD");
    const result = await store.applyWebData(webStatement([
      { id: 9101, on: "2026-03-02", text: "SYNTH BUS FARE", cents: -275 },
      { id: 9102, on: "2026-03-02", text: "SYNTH BUS FARE", cents: -275 },
    ]));
    expect(result).toMatchObject({ transactionsAdded: 1, duplicateTransactionsSkipped: 1 });
    expect(count(db, "SELECT COUNT(*) FROM transactions WHERE description = 'SYNTH BUS FARE'")).toBe(2);
  });

  it("keeps a row whose match is only on another, identified account (a possible duplicate, not an automatic one)", async () => {
    const { db, store } = await fresh();
    await store.importStatement({
      filename: "card.csv", currency: "USD", sha256: "a".repeat(64),
      parsed: { rows: [{ bookedOn: "2026-03-02", description: "SYNTH SHOP", amountCents: -1000, category: "Shopping", taxReview: false, excluded: false }], closingBalanceCents: null, closingBalanceOn: null, dateColumnUsed: null },
      account: { key: "synthbank:1234:credit_card", institution: "Synth Bank", last4: "1234", kind: "credit_card", country: null },
    });
    const result = await store.applyWebData(webStatement([{ id: 9201, on: "2026-03-02", text: "SYNTH SHOP", cents: -1000 }]));
    expect(result).toMatchObject({ transactionsAdded: 1, duplicateTransactionsSkipped: 0 });
    expect(count(db, "SELECT COUNT(*) FROM transactions WHERE description = 'SYNTH SHOP'")).toBe(2);
  });

  it("does not compare website rows with each other or with manual entries", async () => {
    const { store } = await fresh();
    const rows = [{ id: 9301, on: "2026-03-05", text: "SYNTH PARKING", cents: -500 }, { id: 9302, on: "2026-03-05", text: "SYNTH PARKING", cents: -500 }];
    expect(await store.applyWebData(webStatement(rows))).toMatchObject({ transactionsAdded: 2, duplicateTransactionsSkipped: 0 });
  });
});

describe("a write that fails leaves no account, audit row or category behind (A-05)", () => {
  it("an identified-account import refused at commit", async () => {
    const { state, wrap } = failing("INSERT INTO statements");
    const { db, store } = await fresh(wrap);
    state.armed = true;
    await expect(store.importStatement({
      filename: "card.csv", currency: "USD", sha256: "a".repeat(64),
      parsed: { rows: [{ bookedOn: "2026-03-02", description: "SYNTH SHOP", amountCents: -1000, category: "Shopping", taxReview: false, excluded: false }], closingBalanceCents: null, closingBalanceOn: null, dateColumnUsed: null },
      account: { key: "synthbank:1234:credit_card", institution: "Synth Bank", last4: "1234", kind: "credit_card", country: null },
    })).rejects.toThrow(/locked/);
    expect(count(db, "SELECT COUNT(*) FROM statements")).toBe(0);
    expect(count(db, "SELECT COUNT(*) FROM accounts")).toBe(0);
    expect(count(db, "SELECT COUNT(*) FROM audit_events")).toBe(0);
    expect(await store.hasContent()).toBe(false);
    // The same import works once the cause is gone, and creates the account (with its log entry) exactly once.
    state.armed = false;
    await store.importStatement({
      filename: "card.csv", currency: "USD", sha256: "a".repeat(64),
      parsed: { rows: [{ bookedOn: "2026-03-02", description: "SYNTH SHOP", amountCents: -1000, category: "Shopping", taxReview: false, excluded: false }], closingBalanceCents: null, closingBalanceOn: null, dateColumnUsed: null },
      account: { key: "synthbank:1234:credit_card", institution: "Synth Bank", last4: "1234", kind: "credit_card", country: null },
    });
    expect(count(db, "SELECT COUNT(*) FROM accounts WHERE account_key = 'synthbank:1234:credit_card'")).toBe(1);
    expect(count(db, "SELECT COUNT(*) FROM audit_events WHERE subject_type = 'account'")).toBe(1);
    expect(count(db, "SELECT COUNT(*) FROM transactions t JOIN accounts a ON a.id = t.account_id WHERE a.account_key = 'synthbank:1234:credit_card'")).toBe(1);
  });

  it("a second import of the same account adds no second account or log entry", async () => {
    const { db, store } = await fresh();
    for (const [index, sha] of ["b", "c"].entries()) {
      await store.importStatement({
        filename: `card-${index}.csv`, currency: "USD", sha256: sha.repeat(64),
        parsed: { rows: [{ bookedOn: `2026-03-0${index + 2}`, description: `SYNTH ITEM ${index}`, amountCents: -100, category: "Shopping", taxReview: false, excluded: false }], closingBalanceCents: null, closingBalanceOn: null, dateColumnUsed: null },
        account: { key: "synthbank:9999:checking", institution: "Synth Bank", last4: "9999", kind: "checking", country: null },
      });
    }
    expect(count(db, "SELECT COUNT(*) FROM accounts")).toBe(1);
    expect(count(db, "SELECT COUNT(*) FROM audit_events WHERE subject_type = 'account'")).toBe(1);
  });

  it("a website download refused at commit adds neither the 'no account' account nor the website's categories", async () => {
    const { state, wrap } = failing("INSERT INTO transactions");
    const { db, store } = await fresh(wrap);
    state.armed = true;
    await expect(store.applyWebData(webStatement([{ id: 9401, on: "2026-03-02", text: "SYNTH THING", cents: -100 }], { categories: ["Synthetic hobbies"] }))).rejects.toThrow(/locked/);
    expect(count(db, "SELECT COUNT(*) FROM accounts")).toBe(0);
    expect(count(db, "SELECT COUNT(*) FROM custom_categories")).toBe(0);
    expect(await store.hasContent()).toBe(false);
    state.armed = false;
    expect(await store.applyWebData(webStatement([{ id: 9401, on: "2026-03-02", text: "SYNTH THING", cents: -100 }], { categories: ["Synthetic hobbies"] }))).toMatchObject({ transactionsAdded: 1 });
    expect(count(db, "SELECT COUNT(*) FROM custom_categories WHERE name = 'Synthetic hobbies'")).toBe(1);
    expect(count(db, "SELECT COUNT(*) FROM transactions t JOIN accounts a ON a.id = t.account_id WHERE a.account_key = '__unassigned__'")).toBe(1);
  });
});
