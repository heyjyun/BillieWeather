// Crash safety of every financial write: the operation is run again and again, "killing" it before its 1st,
// 2nd, 3rd… write. Whatever the point, the book must equal the state before the operation or after it,
// never something in between (an edit without its protection, a change without its log entry, half a sync).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import initSqlJs, { type Database, type SqlJsStatic } from "sql.js";
import { migrate, MIGRATIONS_DIR } from "./helpers";
import { sqljsDriver } from "../src/services/sqljsDriver";
import { FinanceStore, type SqlDriver } from "../src/services/store";
import { importFile } from "../src/services/importFile";

let SQL: SqlJsStatic;
let seed: Uint8Array;
const KILLED = "killed";

/** Fails the n-th write call (a statement or a whole transaction) and every one after it. */
function killable(driver: SqlDriver, at: number): { driver: SqlDriver; writes: () => number } {
  let writes = 0;
  const gate = () => { writes += 1; if (writes >= at) throw new Error(KILLED); };
  return {
    writes: () => writes,
    driver: {
      ...driver,
      execute: async (sql, params) => { gate(); return driver.execute(sql, params); },
      transaction: async (statements) => { gate(); return driver.transaction(statements); },
    },
  };
}

const VOLATILE = /^(uuid|.*_at|at|batch_id|import_batch_id|subject_id|summary|undo|changes)$/;
/** Everything that matters, without random ids and clock values. Dimensions and categories nothing uses yet do not matter. */
function contents(db: Database): string {
  const tables = ["statements", "transactions", "transaction_links", "transaction_tags", "merchant_rules", "category_meta", "accounts", "budgets", "recurring_rules", "import_staging_rows"];
  const dump = Object.fromEntries(tables.map((table) => {
    const [result] = db.exec(`SELECT * FROM ${table} ORDER BY rowid`);
    if (!result) return [table, []];
    return [table, result.values.map((row) => Object.fromEntries(row.map((value, i) => [result.columns[i], value]).filter(([column]) => !VOLATILE.test(String(column)) || column === "deleted_at" || column === "archived_at").map(([column, value]) => [column, column === "deleted_at" || column === "archived_at" ? value !== null : value])))];
  }));
  // A merchant, project or tag made just before an edit belongs to nothing until the edit is saved.
  const log = db.exec("SELECT actor, action, subject_type, (undo IS NOT NULL) FROM audit_events WHERE subject_type NOT IN ('merchant', 'project', 'tag') ORDER BY id")[0]?.values ?? [];
  const settings = db.exec("SELECT key, value FROM settings WHERE key IN ('currency', 'web_sync_skip') ORDER BY key")[0]?.values ?? [];
  return JSON.stringify({ ...dump, log, settings });
}

const csv = (rows: string[]) => new TextEncoder().encode(["Date,Description,Amount", ...rows].join("\n"));
const web = (rows: number, extra: Partial<Parameters<FinanceStore["applyWebData"]>[0]> = {}) => ({
  currency: "USD" as const,
  statements: [{ remoteId: 1, filename: "w.csv", currency: "USD" as const, sha256: "w", transactionCount: rows, closingBalanceCents: null, closingBalanceOn: null, importedAt: "2026-01-01" }],
  transactions: Array.from({ length: rows }, (_, i) => ({ remoteId: 100 + i, remoteStatementId: 1, bookedOn: "2026-02-01", description: `WEB ${i}`, amountCents: -100 - i, category: "Shopping", taxReview: false, excluded: false })),
  rules: [{ merchantKey: "web shop", income: false, category: "Shopping" as const }], categories: [], ...extra,
});

const idOf = (db: Database, where: string) => Number(db.exec(`SELECT id FROM transactions WHERE ${where} ORDER BY id LIMIT 1`)[0].values[0][0]);

beforeAll(async () => {
  SQL = await initSqlJs();
  const db = new SQL.Database();
  migrate(db);
  const store = new FinanceStore(sqljsDriver(db));
  await store.ledger.setBookCurrency("USD");
  const chk = await store.ledger.createAccount({ name: "Checking", type: "checking", openingBalanceCents: 100_000 });
  const card = await store.ledger.createAccount({ name: "Card", type: "credit_card" });
  await store.ledger.createAccount({ name: "Spare", type: "cash" });
  await importFile(store, csv(["2026-01-02,ZXQ MARKET 1,-10.25", "2026-01-03,ZXQ MARKET 2,-4.00", "2026-01-04,ZXQ SALARY,900.00", "2026-01-05,ZXQ CAFE,-3.50"]), "seed.csv", "USD");
  await store.ledger.createEntry({ kind: "expense", amountCents: 2500, occurredOn: "2026-01-06", accountId: chk.id, category: "Shopping", description: "MANUAL ONE", tags: ["a", "b"] });
  await store.ledger.createEntry({ kind: "transfer", amountCents: 5000, occurredOn: "2026-01-07", accountId: chk.id, toAccountId: card.id });
  await store.addCategory("Pets");
  await store.setCategory(idOf(db, "description LIKE 'ZXQ CAFE%'"), "Pets", false);
  await store.applyWebData(web(3));
  seed = db.export();
});

type Operation = [name: string, run: (store: FinanceStore, db: Database) => Promise<unknown>];
const expense = (db: Database) => idOf(db, "description LIKE 'ZXQ MARKET 1%'");
const manual = (db: Database) => idOf(db, "description = 'MANUAL ONE'");
const account = (db: Database, name: string) => Number(db.exec(`SELECT id FROM accounts WHERE name = '${name}'`)[0].values[0][0]);

const operations: Operation[] = [
  ["import a statement", (s) => importFile(s, csv(["2026-03-01,NEW ONE,-1.00", "2026-03-02,NEW TWO,-2.00"]), "new.csv", "USD")],
  ["choose a category", (s, db) => s.setCategory(expense(db), "Food & dining", false)],
  ["choose a category for many", (s, db) => s.setCategoryMany([expense(db), idOf(db, "description LIKE 'ZXQ MARKET 2%'")], "Food & dining")],
  ["exclude", (s, db) => s.setExcluded(expense(db), true)],
  ["edit an imported entry with tags", (s, db) => s.ledger.updateEntry(expense(db), { kind: "expense", amountCents: 1025, occurredOn: "2026-01-02", accountId: account(db, "Checking"), category: "Pets", description: "Edited", note: "n", tags: ["x"] })],
  ["edit a manual entry with tags", (s, db) => s.ledger.updateEntry(manual(db), { kind: "expense", amountCents: 2600, occurredOn: "2026-01-08", accountId: account(db, "Checking"), category: "Pets", description: "Edited", tags: ["x", "y"] })],
  ["edit a transfer with tags", (s, db) => s.ledger.updateEntry(idOf(db, "kind = 'card_payment' AND amount_cents < 0"), { kind: "transfer", amountCents: 6000, occurredOn: "2026-01-08", accountId: account(db, "Checking"), toAccountId: account(db, "Card"), tags: ["x"] })],
  ["replace tags", (s, db) => s.ledger.setTags([manual(db)], ["z"])],
  ["batch edit with tags", (s, db) => s.ledger.batchUpdate([manual(db)], { category: "Pets", addTags: ["z"], removeTags: ["a"] })],
  ["add an entry with tags", (s, db) => s.ledger.createEntry({ kind: "expense", amountCents: 900, occurredOn: "2026-02-03", accountId: account(db, "Checking"), category: "Pets", description: "ADDED", tags: ["a", "new"], merchant: "New shop" })],
  ["add a transfer with tags", (s, db) => s.ledger.createEntry({ kind: "transfer", amountCents: 900, occurredOn: "2026-02-03", accountId: account(db, "Checking"), toAccountId: account(db, "Card"), tags: ["a"] })],
  ["add a refund", (s, db) => s.ledger.createEntry({ kind: "refund", amountCents: 500, occurredOn: "2026-02-03", accountId: account(db, "Checking"), category: "Shopping", refundOf: manual(db) })],
  ["remember a category for a merchant", (s, db) => s.setCategory(expense(db), "Health", true)],
  ["change a kind", (s, db) => s.ledger.setKind(expense(db), "transfer")],
  ["add an account", (s) => s.ledger.createAccount({ name: "New account", type: "savings", openingBalanceCents: 100 })],
  ["add a schedule", (s, db) => s.ledger.saveRecurringRule({ name: "Rent", template: { kind: "expense", amountCents: 100, accountId: account(db, "Checking"), category: "Housing" }, frequency: "monthly", startOn: "2026-06-01" })],
  ["category settings", (s) => s.ledger.setCategoryMeta("Pets", { kind: "income" }, ["Pets"])],
  ["merge another database", (s) => s.mergeData({ statements: [{ filename: "m.csv", currency: "USD", sha256: "m", closingBalanceCents: null, closingBalanceOn: null, importedAt: "2026-01-01", rows: [{ bookedOn: "2026-01-01", description: "MERGED", amountCents: -5, category: "Shopping", taxReview: false, excluded: false }] }], rules: [{ merchantKey: "merged", income: false, category: "Shopping" }] })],
  ["trash", (s, db) => s.ledger.deleteEntries([manual(db), expense(db)])],
  ["rename a category", (s) => s.renameCategory("Pets", "Animals")],
  ["delete a category", (s) => s.deleteCategory("Pets")],
  ["merge a category", (s) => s.mergeCategory("Pets", "Shopping")],
  ["rename an account", (s, db) => s.ledger.updateAccount(account(db, "Checking"), { name: "Main" })],
  ["archive an account", (s, db) => s.ledger.setAccountArchived(account(db, "Spare"), true)],
  ["delete an account", (s, db) => s.ledger.deleteAccount(account(db, "Spare"))],
  ["adjust a balance", (s, db) => s.ledger.adjustBalance(account(db, "Checking"), 12_345, "2026-02-01")],
  ["save a budget", (s) => s.ledger.saveBudget({ period: "month", category: null, amountCents: 5000 })],
  ["reverse an import", (s, db) => s.reverseImport([Number(db.exec("SELECT id FROM statements WHERE filename = 'seed.csv'")[0].values[0][0])])],
  ["website download: new rows", (s) => s.applyWebData(web(5))],
  ["website download: edits and removals", (s) => s.applyWebData(web(2, { transactions: web(2).transactions.map((t) => ({ ...t, amountCents: -777, category: "Health" })) }))],
  ["website download: a statement removed, another added", (s) => s.applyWebData({ ...web(0), statements: [{ ...web(0).statements[0], remoteId: 2, sha256: "w2", transactionCount: 1 }], transactions: [{ ...web(1).transactions[0], remoteId: 900, remoteStatementId: 2 }] })],
  ["keep website copies as local statements", (s) => s.detachWebCopies()],
  ["delete everything", (s) => s.deleteAllData()],
];

describe("a killed operation leaves the book before or after it, never in between", () => {
  it.each(operations)("%s", async (_name, run) => {
    const finished = new SQL.Database(seed);
    const before = contents(finished);
    await run(new FinanceStore(sqljsDriver(finished)), finished);
    const after = contents(finished);
    expect(after).not.toBe(before);
    for (let at = 1; at < 40; at += 1) {
      const db = new SQL.Database(seed);
      const { driver, writes } = killable(sqljsDriver(db), at);
      const failure = await run(new FinanceStore(driver), db).then(() => null, (error: unknown) => error);
      const state = contents(db);
      if (writes() < at) { // nothing was left to kill
        expect(failure).toBeNull();
        expect(at).toBeGreaterThan(1);
        return;
      }
      if (state !== before && state !== after) {
        const [b, a, now] = [before, after, state].map((text) => JSON.parse(text) as Record<string, unknown>);
        const torn = Object.keys(now).filter((key) => JSON.stringify(now[key]) !== JSON.stringify(b[key]) || JSON.stringify(now[key]) !== JSON.stringify(a[key])).filter((key) => JSON.stringify(a[key]) !== JSON.stringify(b[key]));
        throw new Error(`killed before write ${at}: half-applied (${torn.join(", ")})`);
      }
    }
    throw new Error("the operation never finished");
  });
});

describe("imports that overlap or fail late", () => {
  const fresh = async () => {
    const db = new SQL.Database();
    migrate(db);
    return { db, store: new FinanceStore(sqljsDriver(db)) };
  };
  /** A driver whose transactions wait, so two imports both finish their checks before either writes. */
  const overlapping = (driver: SqlDriver): SqlDriver => ({ ...driver, transaction: async (statements) => { await new Promise((resolve) => setTimeout(resolve, 5)); return driver.transaction(statements); } });
  const FILE = csv(["2026-03-01,ONE,-1.00", "2026-03-02,TWO,-2.00"]);
  const n = (db: Database, sql: string) => Number(db.exec(sql)[0].values[0][0]);

  it("the same file imported twice at once is stored once, and the loser hears it is a duplicate", async () => {
    const { db } = await fresh();
    const store = new FinanceStore(overlapping(sqljsDriver(db)));
    const results = await Promise.allSettled([importFile(store, FILE, "a.csv", "USD"), importFile(store, FILE, "a.csv", "USD")]);
    expect(results.map((result) => result.status).sort()).toEqual(["fulfilled", "rejected"]);
    expect((results.find((result) => result.status === "rejected") as PromiseRejectedResult).reason).toMatchObject({ code: "statement_duplicate" });
    expect([n(db, "SELECT COUNT(*) FROM statements"), n(db, "SELECT COUNT(*) FROM transactions"), n(db, "SELECT COUNT(*) FROM import_staging_rows")]).toEqual([1, 2, 0]);
  });

  it("two currencies imported at once never mix in one book", async () => {
    const { db } = await fresh();
    const store = new FinanceStore(overlapping(sqljsDriver(db)));
    const results = await Promise.allSettled([importFile(store, FILE, "usd.csv", "USD"), importFile(store, csv(["2026-03-01,EURO,-1.00"]), "eur.csv", "EUR")]);
    expect((results.find((result) => result.status === "rejected") as PromiseRejectedResult).reason).toMatchObject({ code: "currency_mismatch" });
    expect(n(db, "SELECT COUNT(DISTINCT currency) FROM statements")).toBe(1);
    expect(n(db, "SELECT COUNT(*) FROM import_staging_rows")).toBe(0);
  });

  it("native error texts (plain strings) are recognized too", async () => {
    for (const [text, code] of [["error returned from database: (code: 2067) UNIQUE constraint failed: statements.sha256", "statement_duplicate"], ["error returned from database: (code: 1555) UNIQUE constraint failed: settings.key", "currency_mismatch"]]) {
      const { db } = await fresh();
      const store = new FinanceStore({ ...sqljsDriver(db), transaction: async () => { throw text; } });
      await expect(importFile(store, FILE, "a.csv", "USD")).rejects.toMatchObject({ code });
    }
  });

  it("a saved import is not reported as failed when filing older rows fails afterwards", async () => {
    const { db } = await fresh();
    const plain = new FinanceStore(sqljsDriver(db));
    await importFile(plain, csv(["2026-01-01,QQZX UNKNOWN PLACE,-9.00"]), "old.csv", "USD");
    const { merchantKey } = await import("@billie/finance-core");
    db.run("INSERT INTO merchant_rules (merchant_key, income, category, updated_at) VALUES (?, 0, 'Shopping', 'x')", [merchantKey("QQZX UNKNOWN PLACE")]);
    let calls = 0;
    const driver = sqljsDriver(db);
    const store = new FinanceStore({ ...driver, transaction: async (statements) => { calls += 1; if (calls > 1) throw new Error("database is locked"); return driver.transaction(statements); } });
    const imported = await importFile(store, FILE, "new.csv", "USD");
    expect(imported).toBeTruthy();
    expect(calls).toBe(2); // filing older rows was attempted and failed
    expect(n(db, "SELECT COUNT(*) FROM statements")).toBe(2);
  });

  it("a website file deleted and uploaded again (same content, new id) replaces its copy", async () => {
    const { db, store } = await fresh();
    await store.applyWebData(web(3));
    const again = { ...web(3), statements: [{ ...web(3).statements[0], remoteId: 7 }], transactions: web(3).transactions.map((t) => ({ ...t, remoteId: t.remoteId + 500, remoteStatementId: 7 })) };
    const result = await store.applyWebData(again);
    expect(result).toMatchObject({ statementsAdded: 1, statementsRemoved: 1, transactionsAdded: 3, transactionsRemoved: 0 });
    expect(db.exec("SELECT remote_id, sha256 FROM statements")[0].values).toEqual([[7, "w"]]);
    expect(n(db, "SELECT COUNT(*) FROM transactions")).toBe(3);
    expect(await store.applyWebData(again)).toMatchObject({ statementsAdded: 0, transactionsAdded: 0, transactionsUpdated: 0, transactionsRemoved: 0 });
  });

  it("a row moved to another website statement keeps this device's edits", async () => {
    const { db, store } = await fresh();
    await store.applyWebData(web(2));
    await store.setCategory(idOf(db, "remote_id = 100"), "Health", false);
    await store.applyWebData({ ...web(2), statements: [{ ...web(2).statements[0], remoteId: 8, sha256: "w8" }], transactions: web(2).transactions.map((t) => ({ ...t, remoteStatementId: 8 })) });
    expect(db.exec("SELECT t.remote_id, t.category, s.remote_id FROM transactions t JOIN statements s ON s.id = t.statement_id ORDER BY t.remote_id")[0].values).toEqual([[100, "Health", 8], [101, "Shopping", 8]]);
  });

  it("a bulk category change records what each entry was before", async () => {
    const db = new SQL.Database(seed);
    const store = new FinanceStore(sqljsDriver(db));
    const ids = [expense(db), idOf(db, "description LIKE 'ZXQ MARKET 2%'")];
    const was = db.exec(`SELECT category FROM transactions WHERE id IN (${ids.join(",")}) ORDER BY id`)[0].values.map(([value]) => value);
    await store.setCategoryMany(ids, "Health");
    const events = (await store.ledger.auditEvents({ limit: 2 })).reverse();
    expect(events.map((event) => event.changes?.category)).toEqual(was.map((value) => [value, "Health"]));
  });

  it("undoing an added transfer still moves both legs to the trash", async () => {
    const db = new SQL.Database(seed);
    const store = new FinanceStore(sqljsDriver(db));
    const ids = await store.ledger.createEntry({ kind: "transfer", amountCents: 900, occurredOn: "2026-02-03", accountId: account(db, "Checking"), toAccountId: account(db, "Card") });
    const [event] = await store.ledger.auditEvents({ limit: 1 });
    expect(event).toMatchObject({ action: "create", undoable: true });
    expect(JSON.parse(String(db.exec("SELECT undo FROM audit_events ORDER BY id DESC LIMIT 1")[0].values[0][0]))).toEqual([{ op: "soft_delete", ids }]);
    expect(ids[1]).toBe(ids[0] + 1);
  });

  it("one change may touch more than 5,000 entries", async () => {
    const limit = Number(/MAX_STATEMENTS: usize = ([\d_]+)/.exec(readFileSync(join(MIGRATIONS_DIR, "../src/transaction.rs"), "utf8"))![1].replaceAll("_", ""));
    expect(limit).toBeGreaterThanOrEqual(100_000);
    const { db, store } = await fresh();
    await importFile(store, csv(Array.from({ length: 5000 }, () => "2026-03-01,QQZX PLACE,-1.00")), "a.csv", "USD");
    await importFile(store, csv(Array.from({ length: 2000 }, () => "2026-03-02,QQZX PLACE,-1.00")), "b.csv", "USD");
    expect(await store.setCategory(1, "Health", true)).toBe(6999);
    expect(n(db, "SELECT COUNT(*) FROM transactions WHERE category = 'Health'")).toBe(7000);
  });
});
