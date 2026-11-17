import { readFileSync } from "node:fs";
import { join } from "node:path";
import initSqlJs from "sql.js";
import { migrate, newStore } from "./helpers";
import { sqljsDriver } from "../src/services/sqljsDriver";
import { FinanceStore } from "../src/services/store";

async function scenario() {
  const { store, db } = await newStore();
  const account = await store.ledger.createAccount({ name: "Synthetic card", type: "credit_card", currency: "USD" });
  const expenseInput = { kind: "expense" as const, amountCents: 8000, occurredOn: "2026-10-01", accountId: account.id, category: "Shopping" };
  const [purchase] = await store.ledger.createEntry(expenseInput);
  const refundInput = { kind: "refund" as const, amountCents: 5000, occurredOn: "2026-10-02", accountId: account.id, category: "Shopping", refundOf: purchase };
  const [refund] = await store.ledger.createEntry(refundInput);
  return { L: store.ledger, db, purchase, refund, expenseInput, refundInput };
}

it("does not restore an old refund when its allowance has been reused", async () => {
  const { L, refund, refundInput } = await scenario();
  await L.deleteEntries([refund]);
  await L.createEntry({ ...refundInput, amountCents: 8000 });
  await expect(L.restoreEntries([refund])).rejects.toThrow();
  expect((await L.entry(refund)).deletedAt).not.toBeNull();
});

it("cannot reduce an expense below already posted refunds", async () => {
  const { L, purchase, expenseInput } = await scenario();
  await expect(L.updateEntry(purchase, { ...expenseInput, amountCents: 4000 })).rejects.toThrow();
  expect((await L.entry(purchase)).amountCents).toBe(-8000);
});

it("updates a refund's amount and its cap accounting together when no target was resubmitted", async () => {
  const { L, refund, purchase, refundInput } = await scenario();
  await L.updateEntry(refund, { ...refundInput, refundOf: undefined, amountCents: 6000 });
  expect((await L.entry(purchase)).refundableCents).toBe(2000);
  await expect(L.updateEntry(refund, { ...refundInput, refundOf: undefined, amountCents: 9000 })).rejects.toThrow();
  expect((await L.entry(refund)).amountCents).toBe(6000);
});

it("enforces the refund cap for writes that bypass UI validation", async () => {
  const { db, refund, purchase } = await scenario();
  expect(() => db.run("UPDATE transactions SET amount_cents = 9000 WHERE id = ?", [refund])).toThrow();
  expect(() => db.run("UPDATE transactions SET amount_cents = -4000 WHERE id = ?", [purchase])).toThrow();
});

it("relinks an existing refund atomically and can undo without double counting", async () => {
  const { L, refund, purchase, expenseInput } = await scenario();
  const [other] = await L.createEntry({ ...expenseInput, amountCents: 6000 });
  await L.linkRefund(refund, other, "ai", "synthetic-relink", "ai");
  expect((await L.entry(purchase)).refundableCents).toBe(8000);
  expect((await L.entry(other)).refundableCents).toBe(1000);
  await L.linkRefund(refund, other);
  await L.undoBatch("synthetic-relink");
  expect((await L.entry(purchase)).refundableCents).toBe(3000);
  expect((await L.entry(other)).refundableCents).toBe(6000);
});

// Migration 0009. Version 8's guard skipped every refund whose insert-time helper was still set,
// which is exactly what an app killed between the INSERT and its cleanup left behind.
describe("refund guard does not depend on insert-time helpers", () => {
  const helpers = (db: Awaited<ReturnType<typeof scenario>>["db"]) =>
    Number(db.exec("SELECT COUNT(*) FROM transactions WHERE link_group IS NOT NULL OR link_hint IS NOT NULL OR link_target_id IS NOT NULL")[0].values[0][0]);
  const liveRefunds = (db: Awaited<ReturnType<typeof scenario>>["db"], expense: number) => Number(db.exec(
    "SELECT COALESCE(SUM(r.amount_cents), 0) FROM transaction_links l JOIN transactions r ON r.id = l.from_transaction_id WHERE l.link_type = 'refund_of' AND l.status = 'confirmed' AND r.deleted_at IS NULL AND l.to_transaction_id = ?", [expense])[0].values[0][0]);

  it("creating entries never leaves a helper behind, also for transfers", async () => {
    const { L, db, refundInput } = await scenario();
    const savings = await L.createAccount({ name: "Synthetic savings", type: "savings", currency: "USD" });
    const [from, to] = await L.createEntry({ kind: "transfer", amountCents: 1200, occurredOn: "2026-10-05", accountId: savings.id, toAccountId: refundInput.accountId });
    expect(to).toBe(from + 1);
    expect((await L.entry(from)).amountCents + (await L.entry(to)).amountCents).toBe(0);
    expect(helpers(db)).toBe(0);
    expect(Number(db.exec("SELECT COUNT(*) FROM transaction_links WHERE link_type IN ('transfer', 'card_payment')")[0].values[0][0])).toBe(1);
  });

  it("a refused refund writes nothing at all", async () => {
    const { L, db, refundInput } = await scenario();
    const before = Number(db.exec("SELECT COUNT(*) FROM transactions")[0].values[0][0]);
    await expect(L.createEntry({ ...refundInput, amountCents: 3001 })).rejects.toThrow();
    expect(Number(db.exec("SELECT COUNT(*) FROM transactions")[0].values[0][0])).toBe(before);
    expect(helpers(db)).toBe(0);
  });

  it("a refund with a leftover helper is still checked when it is restored or raised", async () => {
    const { L, db, purchase, refund, refundInput } = await scenario();
    // A row exactly as an older app version left it when it was killed after the INSERT: the
    // relink trigger is taken away only to write that state, then put back.
    const relink = String(db.exec("SELECT sql FROM sqlite_master WHERE name = 'transactions_refund_relink'")[0].values[0][0]);
    db.run("DROP TRIGGER transactions_refund_relink");
    db.run("UPDATE transactions SET link_hint = 'refund_of', link_target_id = ? WHERE id = ?", [purchase, refund]);
    db.run(relink);
    expect(helpers(db)).toBe(1);

    expect(() => db.run("UPDATE transactions SET amount_cents = 9000 WHERE id = ?", [refund])).toThrow(/refund_too_large/);
    db.run("UPDATE transactions SET deleted_at = '2026-10-03T00:00:00Z' WHERE id = ?", [refund]);
    await L.createEntry({ ...refundInput, amountCents: 8000 });
    expect(() => db.run("UPDATE transactions SET deleted_at = NULL WHERE id = ?", [refund])).toThrow(/refund_too_large/);
    expect(liveRefunds(db, purchase)).toBe(8000);
  });

  it("upgrading a version 8 book clears leftovers and brings link amounts in line without touching any entry", async () => {
    const SQL = await initSqlJs();
    const db = new SQL.Database();
    migrate(db, 8);
    const store = new FinanceStore(sqljsDriver(db));
    const account = await store.ledger.createAccount({ name: "Synthetic card", type: "credit_card", currency: "USD" });
    const [purchase] = await store.ledger.createEntry({ kind: "expense", amountCents: 8000, occurredOn: "2026-10-01", accountId: account.id, category: "Shopping" });
    const [refund] = await store.ledger.createEntry({ kind: "refund", amountCents: 5000, occurredOn: "2026-10-02", accountId: account.id, category: "Shopping", refundOf: purchase });
    // Version 8 state: a leftover helper, and a link amount written before links followed their refund.
    db.run("DROP TRIGGER transactions_refund_relink");
    db.run("UPDATE transactions SET link_hint = 'refund_of', link_target_id = ? WHERE id = ?", [purchase, refund]);
    db.run("DROP TRIGGER transactions_refund_sync_link");
    db.run("UPDATE transaction_links SET amount_cents = 4100 WHERE from_transaction_id = ?", [refund]);
    const entries = () => JSON.stringify(db.exec("SELECT id, booked_on, description, original_description, amount_cents, category, kind, account_id, deleted_at FROM transactions ORDER BY id")[0].values);
    const before = entries();

    db.exec(readFileSync(join(__dirname, "../src-tauri/migrations/0009_refund_guard_and_link_hygiene.sql"), "utf8"));
    expect(entries()).toBe(before);
    expect(helpers(db)).toBe(0);
    expect(db.exec("SELECT amount_cents FROM transaction_links WHERE from_transaction_id = ?", [refund])[0].values[0][0]).toBe(5000);
    expect((await store.ledger.entry(purchase)).refundableCents).toBe(3000);
  });
});
