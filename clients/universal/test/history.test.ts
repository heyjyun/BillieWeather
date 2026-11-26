// Undo and Redo (docs/architecture/editing-history.md): every reversible operation, on the real schema with
// foreign keys enforced as in the app. Synthetic data only.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import initSqlJs, { type Database } from "sql.js";
import { migrate, MIGRATIONS_DIR } from "./helpers";
import { BACKUP_TABLES, createBackup, restoreInto } from "../src/services/backup";
import { importFile } from "../src/services/importFile";
import { analyze, applyProposals, undoRun } from "../src/services/organize";
import { HISTORY_ACTIONS, HISTORY_GROUPS, isRefusal, type HistoryDirection } from "../src/services/history/history";
import { NOT_RECORDED, RECORDED_LEDGER, RECORDED_STORE } from "../src/services/history/policy";
import { recordedStore } from "../src/services/history/recorded";
import { HISTORY_TABLES, imageSql, triggersSql } from "../src/services/history/tables";
import { LedgerStore } from "../src/services/ledger";
import { sqljsDriver } from "../src/services/sqljsDriver";
import { FinanceStore, type SqlDriver } from "../src/services/store";

const CSV = "Date,Description,Amount\n2026-10-01,STARBUCKS STORE 12,-5.00\n2026-10-08,STARBUCKS STORE 99,-4.00\n2026-10-09,ZXQ PAYROLL,2000.00\n";
const csv = (text = CSV) => new TextEncoder().encode(text);

async function open(db: Database) {
  db.run("PRAGMA foreign_keys = ON");
  const store = recordedStore(new FinanceStore(sqljsDriver(db)));
  return { db, store, L: store.ledger, h: store.history, sql: store.sql };
}

async function fresh() {
  const SQL = await initSqlJs();
  const db = new SQL.Database();
  migrate(db);
  return open(db);
}

/** A book with two accounts, an import, manual entries, a transfer, a refund, tags, a budget and a schedule. */
async function book() {
  const made = await fresh();
  const { store, L } = made;
  await L.setBookCurrency("USD");
  const chk = await L.createAccount({ name: "ZXQ Checking", type: "checking", openingBalanceCents: 100_00 });
  const card = await L.createAccount({ name: "ZXQ Card", type: "credit_card" });
  await importFile(store, csv(), "s.csv", "USD");
  const [lunch] = await L.createEntry({ kind: "expense", amountCents: 1234, occurredOn: "2026-10-05", accountId: chk.id, category: "Food & dining", description: "ZXQ LUNCH", merchant: "ZXQ Cafe", project: "ZXQ Trip", tags: ["work", "food"], note: "first" });
  const [out, inn] = await L.createEntry({ kind: "card_payment", amountCents: 5000, occurredOn: "2026-10-06", accountId: chk.id, toAccountId: card.id });
  const [shoes] = await L.createEntry({ kind: "expense", amountCents: 8000, occurredOn: "2026-10-07", accountId: card.id, category: "Shopping", description: "ZXQ SHOES" });
  const [shirt] = await L.createEntry({ kind: "expense", amountCents: 7000, occurredOn: "2026-10-07", accountId: card.id, category: "Shopping", description: "ZXQ SHIRT" });
  const [refund] = await L.createEntry({ kind: "refund", amountCents: 3000, occurredOn: "2026-10-12", accountId: card.id, refundOf: shoes, description: "ZXQ SHOES RETURN" });
  await store.addCategory("ZXQ Hobby");
  await L.saveBudget({ period: "month", category: "Food & dining", amountCents: 20000 });
  const rule = await L.saveRecurringRule({ name: "ZXQ Rent", template: { kind: "expense", amountCents: 90000, accountId: chk.id, category: "Housing", description: "ZXQ RENT" }, frequency: "monthly", startOn: "2026-10-01" });
  const imported = (await made.sql.select<{ id: number }>("SELECT id FROM transactions WHERE entry_origin = 'import' ORDER BY id")).map((row) => row.id);
  return { ...made, ids: { chk: chk.id, card: card.id, lunch, out, inn, shoes, shirt, refund, rule, imported } };
}
type Book = Awaited<ReturnType<typeof book>>;

/** Everything in the book except times that replay sets, the append-only log and the history itself. */
async function dump(sql: SqlDriver) {
  const result: Record<string, unknown> = {};
  const present = new Set((await sql.select<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'")).map((row) => row.name));
  for (const table of BACKUP_TABLES) {
    if (table === "audit_events" || !present.has(table)) continue;
    const rows = await sql.select<Record<string, unknown>>(`SELECT * FROM ${table}`);
    result[table] = rows.map((row) => { const { updated_at: _time, ...rest } = row; return JSON.stringify(rest); }).sort();
  }
  return result;
}

async function sound(sql: SqlDriver) {
  expect(await sql.select("SELECT * FROM pragma_foreign_key_check")).toEqual([]);
  expect((await sql.select<{ integrity_check: string }>("PRAGMA integrity_check"))[0].integrity_check).toBe("ok");
  expect(await sql.select("SELECT group_id, replaying, conflict FROM history_state")).toEqual([{ group_id: null, replaying: 0, conflict: 0 }]);
  expect(await sql.select("SELECT uuid FROM transactions GROUP BY uuid HAVING COUNT(*) > 1")).toEqual([]);
  expect(await sql.select("SELECT id FROM transactions WHERE link_group IS NOT NULL OR link_hint IS NOT NULL OR link_target_id IS NOT NULL")).toEqual([]);
  // A transfer's legs always cancel out and share their state.
  expect(await sql.select(`SELECT l.id FROM transaction_links l JOIN transactions a ON a.id = l.from_transaction_id JOIN transactions b ON b.id = l.to_transaction_id
    WHERE l.link_type IN ('transfer', 'card_payment') AND (a.amount_cents + b.amount_cents <> 0 OR (a.deleted_at IS NULL) <> (b.deleted_at IS NULL))`)).toEqual([]);
}

async function step(made: { h: FinanceStore["history"] }, direction: HistoryDirection) {
  const entry = (await made.h.state())[direction];
  return entry ? made.h.step(direction, entry.id) : "gone";
}

const OPERATIONS: Record<string, (b: Book) => Promise<unknown>> = {
  "amount edit": async ({ L, ids }) => L.updateEntry(ids.lunch, { kind: "expense", amountCents: 99_99, occurredOn: "2026-10-05", accountId: ids.chk, category: "Food & dining", description: "ZXQ LUNCH", merchant: "ZXQ Cafe", project: "ZXQ Trip" }),
  "date and time edit": async ({ L, ids }) => L.updateEntry(ids.lunch, { kind: "expense", amountCents: 1234, occurredOn: "2026-09-30", time: "08:15", accountId: ids.chk, category: "Food & dining", merchant: "ZXQ Cafe", project: "ZXQ Trip" }),
  "merchant and description edit": async ({ L, ids }) => L.updateEntry(ids.lunch, { kind: "expense", amountCents: 1234, occurredOn: "2026-10-05", accountId: ids.chk, category: "Food & dining", description: "ZXQ DINNER “二” \u0007 'q'", merchant: "New Merchant", project: null }),
  "category edit": async ({ L, ids }) => L.updateEntry(ids.lunch, { kind: "expense", amountCents: 1234, occurredOn: "2026-10-05", accountId: ids.chk, category: "Health", merchant: "ZXQ Cafe", project: "ZXQ Trip" }),
  "notes and tags edit": async ({ L, ids }) => L.updateEntry(ids.lunch, { kind: "expense", amountCents: 1234, occurredOn: "2026-10-05", accountId: ids.chk, category: "Food & dining", merchant: "ZXQ Cafe", project: "ZXQ Trip", note: "second", tags: ["food", "new tag"] }),
  "account reassignment": async ({ L, ids }) => L.updateEntry(ids.lunch, { kind: "expense", amountCents: 1234, occurredOn: "2026-10-05", accountId: ids.card, category: "Food & dining", merchant: "ZXQ Cafe", project: "ZXQ Trip" }),
  "imported entry edit": async ({ L, ids }) => L.updateEntry(ids.imported[0], { kind: "expense", amountCents: 500, occurredOn: "2026-10-01", accountId: ids.chk, category: "Food & dining", description: "Coffee", tags: ["x"] }),
  "transfer edit": async ({ L, ids }) => L.updateEntry(ids.out, { kind: "card_payment", amountCents: 7500, occurredOn: "2026-10-20", accountId: ids.chk, toAccountId: ids.card, note: "n", tags: ["pay"] }),
  "refund amount edit": async ({ L, ids }) => L.updateEntry(ids.refund, { kind: "refund", amountCents: 8000, occurredOn: "2026-10-12", accountId: ids.card, description: "ZXQ SHOES RETURN" }),
  "refund moved to another expense": async ({ L, ids }) => L.updateEntry(ids.refund, { kind: "refund", amountCents: 3000, occurredOn: "2026-10-12", accountId: ids.card, refundOf: ids.shirt }),
  "refund becomes income": async ({ L, ids }) => L.updateEntry(ids.refund, { kind: "income", amountCents: 3000, occurredOn: "2026-10-12", accountId: ids.card, category: "Income" }),
  "kind change": async ({ L, ids }) => L.setKind(ids.imported[2], "adjustment"),
  "category in the list": async ({ store, ids }) => store.setCategory(ids.imported[0], "Food & dining", false),
  "category remembered for the merchant": async ({ store, ids }) => store.setCategory(ids.imported[0], "ZXQ Hobby", true),
  "category for many": async ({ store, ids }) => store.setCategoryMany(ids.imported.slice(0, 2), "Transport"),
  "exclude": async ({ store, ids }) => store.setExcluded(ids.lunch, true),
  "batch edit": async ({ L, ids }) => L.batchUpdate([ids.lunch, ids.shoes, ids.imported[0]], { category: "Transport", merchant: "Batch M", project: "Batch P", accountId: ids.card, addTags: ["batch"], removeTags: ["work"] }),
  "tags only": async ({ L, ids }) => L.setTags([ids.lunch, ids.shoes], ["only"]),
  "create expense": async ({ L, ids }) => L.createEntry({ kind: "expense", amountCents: 100, occurredOn: "2026-10-30", accountId: ids.chk, description: "ZXQ NEW", merchant: "Brand new", tags: ["fresh"] }),
  "create transfer": async ({ L, ids }) => L.createEntry({ kind: "transfer", amountCents: 100, occurredOn: "2026-10-30", accountId: ids.chk, toAccountId: ids.card }),
  "create refund": async ({ L, ids }) => L.createEntry({ kind: "refund", amountCents: 5000, occurredOn: "2026-10-30", accountId: ids.card, refundOf: ids.shoes }),
  "duplicate a transfer": async ({ L, ids }) => L.duplicateEntry(ids.out),
  "adjust a balance": async ({ L, ids }) => L.adjustBalance(ids.chk, 777_00, "2026-10-31"),
  "delete an entry": async ({ L, ids }) => L.deleteEntries([ids.lunch]),
  "delete a transfer": async ({ L, ids }) => L.deleteEntries([ids.inn]),
  "delete an expense and its refund": async ({ L, ids }) => L.deleteEntries([ids.shoes, ids.refund]),
  "link a transfer": async ({ L, ids }) => L.linkTransfer(ids.shirt, (await L.createEntry({ kind: "income", amountCents: 7000, occurredOn: "2026-10-08", accountId: ids.chk }))[0]),
  "mark a duplicate": async ({ L, ids }) => L.markDuplicate(ids.imported[1], ids.imported[0]),
  "account created": async ({ L }) => L.createAccount({ name: "ZXQ Cash", type: "cash" }),
  "account edited": async ({ L, ids }) => L.updateAccount(ids.chk, { name: "Renamed", openingBalanceCents: 5, note: "n" }),
  "account archived": async ({ L, ids }) => L.setAccountArchived(ids.card, true),
  "accounts reordered": async ({ L, ids }) => L.reorderAccounts([ids.card, ids.chk]),
  "category renamed": async ({ store, ids }) => { await store.setCategoryMany([ids.lunch], "ZXQ Hobby"); await store.renameCategory("ZXQ Hobby", "zxq hobby"); },
  "category deleted": async ({ store }) => store.deleteCategory("ZXQ Hobby"),
  "category merged": async ({ store }) => { await store.addCategory("ZXQ Other"); await store.mergeCategory("ZXQ Hobby", "ZXQ Other"); },
  "category tree": async ({ store, L }) => L.setCategoryMeta("ZXQ Hobby", { parent: "Shopping" }, await store.customCategories()),
  "categories reordered": async ({ L }) => L.reorderCategories(["Food & dining", "ZXQ Hobby"]),
  "merchant renamed": async ({ L }) => L.renameDimension("merchant", (await L.dimensions("merchant"))[0].id, "zxq cafe 2"),
  "merchant merged": async ({ L }) => { const other = await L.createDimension("merchant", "Other M"); await L.mergeDimension("merchant", (await L.dimensions("merchant")).find((d) => d.name === "ZXQ Cafe")!.id, other.id); },
  "tag merged": async ({ L }) => { const [a, b] = await L.dimensions("tag"); await L.mergeDimension("tag", a.id, b.id); },
  "tag deleted": async ({ L }) => L.deleteDimension("tag", (await L.dimensions("tag"))[0].id),
  "project deleted with its budget": async ({ L }) => { const [p] = await L.dimensions("project"); await L.saveBudget({ period: "year", projectId: p.id, amountCents: 5 }); await L.deleteDimension("project", p.id); },
  "budget changed": async ({ L }) => { const [b] = await L.budgets(); await L.saveBudget({ id: b.id, period: "year", category: "Food & dining", amountCents: 1 }); },
  "budget deleted": async ({ L }) => L.deleteBudget((await L.budgets())[0].id),
  "schedule changed": async ({ L, ids }) => L.saveRecurringRule({ id: ids.rule, name: "Other", template: { kind: "expense", amountCents: 1, accountId: ids.card, category: "Housing" }, frequency: "weekly", startOn: "2026-11-01" }),
  "schedule posted": async ({ L }) => L.postDue("2026-11-15"),
  "schedule skipped": async ({ L, ids }) => L.skipOccurrence(ids.rule),
  "schedule deleted after posting": async ({ L, ids }) => { await L.postDue("2026-11-15"); await L.deleteRecurringRule(ids.rule); },
  "import": async ({ store }) => importFile(store, csv("Date,Description,Amount\n2026-11-01,STARBUCKS STORE 7,-5.50\n2026-11-02,ZXQ OTHER,-1.00\n"), "t.csv", "USD"),
  "import undone by its button": async ({ store }) => store.reverseImport([(await store.statements())[0].id]),
  "region and reclassify": async ({ store }) => { const { id } = (await store.statements())[0]; await store.setStatementRegion([id], "US"); await store.reclassifyStatements([id]); },
  "organize run": async ({ store }) => { const { runId, proposals } = await analyze(store, store.sql); await store.record("organize", (s) => applyProposals(s, s.sql, runId, proposals, { rememberCategories: true })); },
  "organize run undone by its button": async ({ store }) => { const { runId, proposals } = await analyze(store, store.sql); const { batchId } = await store.record("organize", (s) => applyProposals(s, s.sql, runId, proposals)); await store.record("organize_undo", (s) => undoRun(s, s.sql, batchId)); },
  "month start": async ({ L }) => L.setMonthStartDay(15),
};

describe("every reversible operation", () => {
  for (const [name, operation] of Object.entries(OPERATIONS)) {
    it(`${name}: undo restores the book exactly, redo repeats it, three times`, async () => {
      const made = await book();
      const before = await dump(made.sql);
      const first = (await made.h.state()).undo!.id;
      const groups = async () => (await made.sql.select<{ id: number }>("SELECT id FROM history_groups WHERE undone_at IS NULL AND id > ? ORDER BY id", [first])).length;
      if (name === "organize run" || name === "organize run undone by its button") {
        // The preview itself is not an edit.
        await operation(made);
      } else await operation(made);
      const after = await dump(made.sql);
      const count = await groups();
      expect(count).toBeGreaterThan(0);
      for (let round = 0; round < 3; round += 1) {
        for (let i = 0; i < count; i += 1) expect(await step(made, "undo")).toBe("done");
        await sound(made.sql);
        const undone = await dump(made.sql);
        // A preview is stored before the edit and stays.
        if (name.startsWith("organize")) undone.organize_runs = before.organize_runs;
        expect(undone).toEqual(before);
        for (let i = 0; i < count; i += 1) expect(await step(made, "redo")).toBe("done");
        await sound(made.sql);
        expect(await dump(made.sql)).toEqual(after);
      }
    });
  }

  it("undoes the whole book step by step to nothing and redoes it completely", async () => {
    const made = await book();
    const full = await dump(made.sql);
    let steps = 0;
    while ((await made.h.state()).undo) { expect(await step(made, "undo")).toBe("done"); steps += 1; await sound(made.sql); }
    expect(steps).toBeGreaterThan(10);
    expect(await made.sql.select("SELECT id FROM transactions")).toEqual([]);
    expect(await made.sql.select("SELECT id FROM accounts")).toEqual([]);
    while ((await made.h.state()).redo) expect(await step(made, "redo")).toBe("done");
    expect(await dump(made.sql)).toEqual(full);
    await sound(made.sql);
  });
});

describe("history boundaries", () => {
  it("names the edit and the entry it would undo", async () => {
    const made = await book();
    await made.L.deleteEntries([made.ids.lunch]);
    expect((await made.h.state()).undo).toMatchObject({ action: "delete", entries: 1, description: "ZXQ LUNCH" });
    await made.store.setCategoryMany(made.ids.imported, "Transport");
    expect((await made.h.state()).undo).toMatchObject({ action: "batch_edit", entries: 3, description: null });
  });

  it("a new edit ends what could be redone; reading and refused edits do not", async () => {
    const made = await book();
    await made.store.setExcluded(made.ids.lunch, true);
    await step(made, "undo");
    await made.store.transactions();
    await expect(made.L.updateEntry(made.ids.lunch, { kind: "expense", amountCents: 0, occurredOn: "x", accountId: 0 })).rejects.toThrow();
    await made.L.setMonthStartDay(1); await made.L.setMonthStartDay(1);
    await step(made, "undo"); // the month start: an edit of its own
    expect((await made.h.state()).redo).not.toBeNull();
    await made.L.deleteEntries([made.ids.shirt]);
    expect((await made.h.state()).redo).toBeNull();
    expect(await made.sql.select("SELECT id FROM history_groups WHERE undone_at IS NOT NULL")).toEqual([]);
  });

  it("an edit that changes nothing is no history entry and keeps redo", async () => {
    const made = await book();
    await made.store.setExcluded(made.ids.lunch, true);
    await step(made, "undo");
    const shown = await made.h.state();
    await made.L.setAccountArchived(made.ids.chk, false);
    await made.L.reorderAccounts([]);
    expect(await made.h.state()).toEqual(shown);
  });

  it("keeps the newest edits only", async () => {
    const made = await book();
    for (let i = 0; i < HISTORY_GROUPS + 5; i += 1) await made.store.setExcluded(made.ids.lunch, i % 2 === 0);
    expect(await made.sql.select("SELECT COUNT(*) AS n FROM history_groups")).toEqual([{ n: HISTORY_GROUPS }]);
    expect(await made.sql.select("SELECT COUNT(*) AS n FROM history_changes WHERE group_id NOT IN (SELECT id FROM history_groups)")).toEqual([{ n: 0 }]);
  });

  it("undoes only the edit that was shown", async () => {
    const made = await book();
    const shown = (await made.h.state()).undo!;
    await made.store.setExcluded(made.ids.lunch, true);
    const before = await dump(made.sql);
    expect(await made.h.step("undo", shown.id)).toBe("gone");
    expect(await made.h.step("redo", shown.id)).toBe("gone");
    expect(await dump(made.sql)).toEqual(before);
    // Two presses at once undo one edit.
    const newest = (await made.h.state()).undo!;
    expect((await Promise.all([made.h.step("undo", newest.id), made.h.step("undo", newest.id)])).sort()).toEqual(["done", "gone"]);
  });

  it("is written to the operation log, which itself is never undone", async () => {
    const made = await book();
    const [{ n }] = await made.sql.select<{ n: number }>("SELECT COUNT(*) AS n FROM audit_events");
    await made.L.deleteEntries([made.ids.lunch]);
    await step(made, "undo");
    await step(made, "redo");
    const events = await made.L.auditEvents({ limit: 3 });
    expect(events.map((event) => event.action)).toEqual(["redo", "undo", "delete"]);
    expect(await made.sql.select("SELECT COUNT(*) AS n FROM audit_events")).toEqual([{ n: n + 3 }]);
  });

  it("survives a restart: the same edits can be undone and redone from a reopened file", async () => {
    const made = await book();
    const before = await dump(made.sql);
    await made.L.deleteEntries([made.ids.lunch, made.ids.out]);
    const after = await dump(made.sql);
    const SQL = await initSqlJs();
    const again = await open(new SQL.Database(made.db.export()));
    expect(await step(again, "undo")).toBe("done");
    expect(await dump(again.sql)).toEqual(before);
    const third = await open(new SQL.Database(again.db.export()));
    expect(await step(third, "redo")).toBe("done");
    expect(await dump(third.sql)).toEqual(after);
  });

  it("belongs to one database and stays out of backups", async () => {
    const made = await book();
    const content = await createBackup(made.sql);
    expect(Object.keys(content.tables).filter((name) => name.startsWith("history"))).toEqual([]);
    const target = await fresh();
    await restoreInto(target.sql, content, { owner: null, name: "copy" } as never);
    expect(await target.h.state()).toEqual({ undo: null, redo: null });
    await sound(target.sql);
  });
});

describe("protection", () => {
  it("keeps the person's classification protected through undo and redo", async () => {
    const made = await book();
    const id = made.ids.imported[0];
    const row = async () => (await made.sql.select<Record<string, unknown>>("SELECT category, category_source, user_locked_fields, locally_modified FROM transactions WHERE id = ?", [id]))[0];
    const untouched = await row();
    await made.store.setCategory(id, "Transport", false);
    const chosen = await row();
    expect(chosen).toMatchObject({ category: "Transport", category_source: "user", locally_modified: 1 });
    await made.L.updateEntry(id, { kind: "expense", amountCents: 500, occurredOn: "2026-10-01", accountId: made.ids.chk, category: "Transport", note: "later" });
    await step(made, "undo");
    expect(await row()).toEqual(chosen);
    // Automation does not touch it: not a rule, a reclassify, nor a batch that respects locks.
    await made.store.reclassifyStatements([(await made.store.statements())[0].id]);
    await made.L.batchUpdate([id], { category: "Food & dining" }, "ai", null, { lock: false });
    expect(await row()).toMatchObject({ category: "Transport", category_source: "user" });
    while ((await made.h.state()).undo?.action !== "category") await step(made, "undo");
    await step(made, "undo");
    expect(await row()).toEqual(untouched);
    await step(made, "redo");
    expect(await row()).toEqual(chosen);
  });

  it("never overwrites a later change it did not record: the edit is dropped, nothing is written", async () => {
    const made = await book();
    await made.L.deleteEntries([made.ids.shirt]);
    await made.store.setExcluded(made.ids.lunch, true);
    await made.sql.execute("UPDATE transactions SET description = 'from the website' WHERE id = ?", [made.ids.lunch]);
    const before = await dump(made.sql);
    expect(await step(made, "undo")).toBe("conflict");
    expect(await dump(made.sql)).toEqual(before);
    await sound(made.sql);
    // The edit before it is independent and still exact.
    expect((await made.h.state()).undo).toMatchObject({ action: "delete" });
    expect(await step(made, "undo")).toBe("done");
    await sound(made.sql);
  });

  it("a redo that no longer fits takes the redos that build on it along", async () => {
    const made = await book();
    await made.store.setExcluded(made.ids.lunch, true);
    await made.L.deleteEntries([made.ids.lunch]);
    await step(made, "undo"); await step(made, "undo");
    await made.sql.execute("UPDATE transactions SET note = 'changed' WHERE id = ?", [made.ids.lunch]);
    const before = await dump(made.sql);
    expect(await step(made, "redo")).toBe("conflict");
    expect((await made.h.state()).redo).toBeNull();
    expect(await dump(made.sql)).toEqual(before);
  });

  it("does not remove an entry something else refers to", async () => {
    const made = await book();
    const [bag] = await made.L.createEntry({ kind: "expense", amountCents: 900, occurredOn: "2026-10-30", accountId: made.ids.chk, description: "BAG" });
    const raw = new LedgerStore(made.sql); // not recorded, like a background writer
    await raw.createEntry({ kind: "refund", amountCents: 300, occurredOn: "2026-10-31", accountId: made.ids.chk, refundOf: bag });
    const before = await dump(made.sql);
    expect(await step(made, "undo")).toBe("conflict");
    expect(await dump(made.sql)).toEqual(before);
    await sound(made.sql);
  });

  it("keeps an account, merchant or tag another entry uses by now", async () => {
    const made = await book();
    await made.L.createEntry({ kind: "expense", amountCents: 900, occurredOn: "2026-10-30", accountId: made.ids.chk, description: "A", merchant: "Shared", tags: ["shared"] });
    const raw = new LedgerStore(made.sql);
    const [other] = await raw.createEntry({ kind: "expense", amountCents: 100, occurredOn: "2026-10-31", accountId: made.ids.chk, description: "B", merchant: "Shared", tags: ["shared"] });
    expect(await step(made, "undo")).toBe("done");
    expect(await raw.entry(other)).toMatchObject({ merchant: "Shared", tags: ["shared"] });
    await sound(made.sql);
    expect(await step(made, "redo")).toBe("done");
    await sound(made.sql);
  });

  it("does not undo creating an account or category that is in use by now", async () => {
    const made = await book();
    const cash = await made.L.createAccount({ name: "Cash", type: "cash" });
    await new LedgerStore(made.sql).createEntry({ kind: "expense", amountCents: 100, occurredOn: "2026-10-31", accountId: cash.id });
    expect(await step(made, "undo")).toBe("conflict");
    await made.store.addCategory("ZXQ Used");
    await made.sql.execute("UPDATE transactions SET category = 'ZXQ Used' WHERE id = ?", [made.ids.shirt]);
    expect(await step(made, "undo")).toBe("conflict");
    expect(await made.store.customCategories()).toContain("ZXQ Used");
    await sound(made.sql);
  });

  it("an undone import can be imported again without duplicates, which ends its redo", async () => {
    const made = await fresh();
    await importFile(made.store, csv(), "s.csv", "USD");
    await step(made, "undo");
    expect(await made.store.transactions()).toEqual([]);
    expect(await made.store.currency()).toBeNull();
    await importFile(made.store, csv(), "s.csv", "USD");
    expect((await made.store.transactions()).length).toBe(3);
    expect((await made.h.state()).redo).toBeNull();
    await expect(importFile(made.store, csv(), "s.csv", "USD")).rejects.toThrow();
    await sound(made.sql);
  });

  it("a refused write leaves neither the change nor history behind, at every statement of an undo", async () => {
    const made = await book();
    await made.L.batchUpdate([made.ids.lunch, made.ids.shoes], { category: "Transport", merchant: "M", addTags: ["t"] });
    const before = await dump(made.sql);
    const groups = await made.sql.select("SELECT * FROM history_groups");
    const driver = made.sql;
    const { replayStatements } = await import("../src/services/history/history");
    const statements = replayStatements((await made.h.state()).undo!.id, "undo");
    for (let at = 0; at <= statements.length; at += 1) {
      await expect(driver.transaction([...statements.slice(0, at), { sql: "INSERT INTO no_such_table VALUES (1)" }])).rejects.toThrow();
      expect(await dump(driver)).toEqual(before);
      expect(await driver.select("SELECT * FROM history_groups")).toEqual(groups);
    }
    await sound(driver);
    expect(await step(made, "undo")).toBe("done");
  });

  it("a failure that is not a refusal (a busy or unreadable database) keeps the edit undoable", async () => {
    const made = await book();
    const shown = (await made.h.state()).undo!;
    const real = made.sql.transaction;
    made.sql.transaction = () => Promise.reject(new Error("error returned from database: (code: 5) database is locked"));
    await expect(made.h.step("undo", shown.id)).rejects.toThrow("locked");
    made.sql.transaction = real;
    expect((await made.h.state()).undo!.id).toBe(shown.id);
    expect(await step(made, "undo")).toBe("done");
    expect(isRefusal("error returned from database: (code: 275) CHECK constraint failed: history_conflict")).toBe(true);
  });
});

describe("permanent deletion", () => {
  it("cannot be undone and leaves no copy of the entry in the history", async () => {
    const made = await book();
    await made.L.updateEntry(made.ids.lunch, { kind: "expense", amountCents: 1, occurredOn: "2026-10-05", accountId: made.ids.chk, description: "SECRET LUNCH" });
    await made.L.deleteEntries([made.ids.lunch]);
    await made.L.purgeEntries([made.ids.lunch]);
    const rest = await made.sql.select<{ text: string }>("SELECT COALESCE(before_image, '') || COALESCE(after_image, '') AS text FROM history_changes");
    expect(rest.some((row) => row.text.includes("SECRET LUNCH") || row.text.includes("ZXQ LUNCH"))).toBe(false);
    expect(await made.sql.select("SELECT c.id FROM history_changes c WHERE table_name = 'transactions' AND row_key = json_array(?)", [made.ids.lunch])).toEqual([]);
    const uuid = await made.sql.select("SELECT 1 FROM transactions WHERE description LIKE '%LUNCH%'");
    expect(uuid).toEqual([]);
    while ((await made.h.state()).undo) { await step(made, "undo"); await sound(made.sql); }
    expect(await made.sql.select("SELECT 1 FROM transactions WHERE description LIKE '%LUNCH%'")).toEqual([]);
    while ((await made.h.state()).redo) await step(made, "redo");
    expect(await made.sql.select("SELECT 1 FROM transactions WHERE description LIKE '%LUNCH%'")).toEqual([]);
    await sound(made.sql);
  });

  it("ends a redo that would bring the entry back", async () => {
    const made = await book();
    await made.L.deleteEntries([made.ids.shirt]);
    await made.L.restoreEntries([made.ids.shirt]);
    await step(made, "undo");
    await made.L.emptyTrash();
    expect((await made.h.state()).redo).toBeNull();
  });

  it("removing a statement for good and deleting everything keep nothing", async () => {
    const made = await book();
    await made.store.setCategoryMany(made.ids.imported, "Transport");
    await made.store.removeStatement((await made.store.statements())[0].id);
    const text = async () => (await made.sql.select<{ text: string }>("SELECT COALESCE(before_image, '') || COALESCE(after_image, '') AS text FROM history_changes WHERE table_name = 'transactions'")).map((row) => row.text).join();
    expect(await text()).not.toContain("STARBUCKS");
    await made.store.deleteAllData();
    expect(await made.sql.select("SELECT (SELECT COUNT(*) FROM history_groups) + (SELECT COUNT(*) FROM history_changes) AS n")).toEqual([{ n: 0 }]);
    expect(await made.h.state()).toEqual({ undo: null, redo: null });
  });
});

describe("the recorder", () => {
  it("records every column of every recorded table, and its triggers are the ones migration 0010 creates", async () => {
    const { sql } = await fresh();
    for (const table of HISTORY_TABLES) {
      const columns = (await sql.select<{ name: string }>(`SELECT name FROM pragma_table_info('${table.name}')`)).map((row) => row.name);
      expect([...table.columns, ...table.excluded].sort()).toEqual([...columns].sort());
      for (const trigger of Object.values(triggersSql(table))) {
        const name = /TRIGGER (\w+)/.exec(trigger)![1];
        const [found] = await sql.select<{ sql: string }>("SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = ?", [name]);
        expect(`${found.sql};`).toBe(trigger);
      }
    }
    expect(imageSql(HISTORY_TABLES[0], "x")).toBe("json_object('key', x.key, 'value', x.value)");
    expect(readFileSync(join(MIGRATIONS_DIR, "0010_editing_history.sql"), "utf8")).not.toMatch(/\b(DROP|ALTER)\b/);
  });

  it("every writing operation is either an undoable edit or listed with the reason it is not", () => {
    const listed = new Set([...Object.keys(RECORDED_STORE), ...Object.keys(RECORDED_LEDGER), ...Object.keys(NOT_RECORDED), "record"]);
    const writes = (file: string) => {
      const source = readFileSync(join(__dirname, "../src/services", file), "utf8");
      const methods = [...source.matchAll(/^  (?:private )?(?:static )?(?:async )?([a-zA-Z]+)\(.*\{$/gm)];
      return methods.flatMap((method, index) => {
        const body = source.slice(method.index, methods[index + 1]?.index ?? source.length);
        return /\b(db\.(execute|transaction)|setSetting|removeStatements|commitStaged)\(/.test(body) && method[1] !== "constructor" && !method[0].startsWith("  private") ? [method[1]] : [];
      });
    };
    const found = [...new Set([...writes("store.ts"), ...writes("ledger.ts")])];
    expect(found.length).toBeGreaterThan(45);
    expect(found.filter((name) => !listed.has(name))).toEqual([]);
    for (const name of [...Object.keys(RECORDED_STORE)]) expect(name in FinanceStore.prototype).toBe(true);
    for (const name of [...Object.keys(RECORDED_LEDGER)]) expect(name in LedgerStore.prototype).toBe(true);
    for (const action of [...Object.values(RECORDED_STORE), ...Object.values(RECORDED_LEDGER)]) if (typeof action === "string") expect(HISTORY_ACTIONS).toContain(action);
  });

  it("does not record the website's download or a schedule posting by itself", async () => {
    const made = await book();
    const shown = await made.h.state();
    await made.L.saveRecurringRule({ name: "Auto", template: { kind: "expense", amountCents: 5, accountId: made.ids.chk, category: "Housing" }, frequency: "monthly", startOn: "2026-10-02", autoPost: true });
    const after = await made.h.state();
    expect(after.undo!.id).toBeGreaterThan(shown.undo!.id);
    expect(await made.L.postDue("2026-10-20", { onlyAuto: true })).toBe(1);
    expect(await made.h.state()).toEqual(after);
  });

  it("tells its listeners after an edit and after a step", async () => {
    const made = await book();
    let calls = 0;
    const stop = made.h.subscribe(() => { calls += 1; });
    await made.store.setExcluded(made.ids.lunch, true);
    expect(calls).toBe(1);
    await step(made, "undo");
    expect(calls).toBe(2);
    stop();
    await step(made, "redo");
    expect(calls).toBe(2);
  });

  it("undoes and redoes an import of 5,000 rows in one step", async () => {
    const made = await fresh();
    const rows = Array.from({ length: 5000 }, (_, i) => `2026-${String(1 + (i % 12)).padStart(2, "0")}-${String(1 + (i % 28)).padStart(2, "0")},ZXQ BULK ${i},-${1 + (i % 90)}.${String(i % 100).padStart(2, "0")}`);
    await importFile(made.store, csv(`Date,Description,Amount\n${rows.join("\n")}\n`), "bulk.csv", "USD");
    const after = await dump(made.sql);
    expect((await made.h.state()).undo).toMatchObject({ action: "import", entries: 5000 });
    expect(await step(made, "undo")).toBe("done");
    expect(await made.sql.select("SELECT COUNT(*) AS n FROM transactions")).toEqual([{ n: 0 }]);
    expect(await step(made, "redo")).toBe("done");
    expect(await dump(made.sql)).toEqual(after);
    await sound(made.sql);
  }, 60_000);
});

describe("upgrade from version 9", () => {
  it("keeps every row and starts with an empty history", async () => {
    const SQL = await initSqlJs();
    const db = new SQL.Database();
    migrate(db, 9);
    // A version-9 book as that version wrote it (today's store reads the version-11 category tree).
    db.exec(`INSERT INTO statements (id, filename, currency, sha256, transaction_count, imported_at) VALUES (1, 's.csv', 'USD', 's', 2, '2026-11-20');
      INSERT INTO transactions (id, statement_id, booked_on, description, amount_cents, category, updated_at, uuid) VALUES
        (1, 1, '2026-11-20', 'Synthetic Coffee', -450, 'Food & dining', '2026-11-20', 'u1'), (2, 1, '2026-11-21', 'Synthetic Store', -1025, 'Shopping', '2026-11-21', 'u2');`);
    const withoutTree = async (sql: SqlDriver) => { const { categories: _tree, ...rest } = await dump(sql); return rest; };
    const before = await withoutTree(sqljsDriver(db));
    migrate(db);
    const now = await open(db);
    expect(await withoutTree(now.sql)).toEqual({ ...before, settings: [...(before.settings as string[]), JSON.stringify({ key: "category_seed", value: "legacy" })].sort() });
    // The nine old built-ins became ordinary categories with their legacy keys; nothing new was added.
    expect((await now.store.categoryRows()).map((row) => row.key).sort()).toEqual(["business", "food", "health", "housing", "income", "shopping", "transfers", "transport", "utilities"]);
    expect(await now.h.state()).toEqual({ undo: null, redo: null });
    const [{ id }] = await now.store.transactions();
    await now.store.setExcluded(id, true);
    expect(await step(now, "undo")).toBe("done");
    expect((await withoutTree(now.sql)).transactions).toEqual(before.transactions);
  });
});
