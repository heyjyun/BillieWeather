// Undo never overwrites what a person did afterwards, and one event is reversed completely or not at all.
import { newStore } from "./helpers";
import { analyze, applyProposals, undoRun } from "../src/services/organize";
import { importFile } from "../src/services/importFile";

async function book() {
  const { store } = await newStore();
  const L = store.ledger;
  await L.setBookCurrency("USD");
  const chk = await L.createAccount({ name: "ZXQ Checking", type: "checking" });
  const card = await L.createAccount({ name: "ZXQ Card", type: "credit_card" });
  await importFile(store, new TextEncoder().encode("Date,Description,Amount\n2026-10-01,STARBUCKS STORE 12,-5.00\n2026-10-08,STARBUCKS STORE 99,-4.00\n"), "s.csv", "USD");
  await store.sql.execute("UPDATE transactions SET category = 'Uncategorized', category_source = 'legacy' WHERE description LIKE 'STARBUCKS%'");
  const insert = async (account: number, date: string, description: string, cents: number, kind: string, category: string) => {
    await store.sql.execute("INSERT INTO transactions (statement_id, account_id, booked_on, description, amount_cents, category, kind, entry_origin, updated_at) VALUES ((SELECT MIN(id) FROM statements), ?, ?, ?, ?, ?, ?, 'import', 'x')",
      [account, date, description, cents, category, kind]);
    return Number((await store.sql.select<{ id: number }>("SELECT MAX(id) AS id FROM transactions"))[0].id);
  };
  const out = await insert(chk.id, "2026-10-28", "ONLINE PMT TO CARD", -17000, "expense", "Uncategorized");
  const inn = await insert(card.id, "2026-10-29", "PAYMENT RECEIVED", 17000, "income", "Income");
  const dupA = await insert(chk.id, "2026-10-20", "ZXQ GYM", -3000, "expense", "Health");
  const dupB = await insert(chk.id, "2026-10-20", "ZXQ GYM", -3000, "expense", "Health");
  const [purchase] = await L.createEntry({ kind: "expense", amountCents: 8000, occurredOn: "2026-10-09", accountId: card.id, description: "ZXQ OUTFITTERS" });
  const refund = await insert(card.id, "2026-10-15", "ZXQ OUTFITTERS RETURN", 3000, "income", "Income");
  return { store, L, db: store.sql, insert, ids: { out, inn, dupA, dupB, purchase, refund }, accounts: { chk: chk.id, card: card.id } };
}

async function organized() {
  const made = await book();
  const { runId, proposals } = await analyze(made.store, made.db);
  const { batchId } = await applyProposals(made.store, made.db, runId, proposals.filter((p) => p.type !== "merchant"));
  return { ...made, batchId };
}

const rowsOf = async (db: Awaited<ReturnType<typeof book>>["db"]) => JSON.stringify(await db.select("SELECT id, kind, category, category_source, user_locked_fields, excluded, deleted_at IS NOT NULL AS trashed FROM transactions ORDER BY id"));

it("keeps a category a person chose after the run, and still undoes the rest", async () => {
  const { store, db, batchId, ids } = await organized();
  const [first, second] = (await store.transactions()).filter((t) => t.description.startsWith("STARBUCKS"));
  await store.setCategory(first.id, "Business", false);
  await undoRun(store, db, batchId);
  expect((await store.ledger.entry(first.id)).category).toBe("Business");
  expect((await store.ledger.entry(second.id)).category).toBe("Uncategorized");
  expect((await store.ledger.entry(ids.refund)).refundOf).toBeNull();
});

it("keeps a merchant, kind or account a person set afterwards", async () => {
  const { store, L, ids, accounts } = await book();
  const [a, b] = (await store.transactions()).filter((t) => t.description.startsWith("STARBUCKS"));
  await L.batchUpdate([a.id, b.id], { merchant: "Wrong name" }, "ai", "batch-1", { lock: false });
  await L.batchUpdate([a.id], { merchant: "My coffee place" });
  await L.setKind(ids.refund, "refund", "ai", "batch-1", { lock: false });
  await L.setKind(ids.refund, "income");
  await L.batchUpdate([b.id], { accountId: accounts.card }, "ai", "batch-2");
  await L.batchUpdate([b.id], { accountId: accounts.chk });
  await L.undoBatch("batch-1");
  await L.undoBatch("batch-2");
  expect((await L.entry(a.id)).merchant).toBe("My coffee place");
  expect((await L.entry(b.id)).merchant).toBeNull();
  expect((await L.entry(ids.refund)).kind).toBe("income");
  expect((await L.entry(b.id)).accountId).toBe(accounts.chk);
});

it("leaves a transfer pair whole when one side was changed since", async () => {
  const { L, db, batchId, ids } = await organized();
  expect((await L.entry(ids.inn)).counterpart?.id).toBe(ids.out);
  await db.execute("UPDATE transactions SET category = 'Fees' WHERE id = ?", [ids.out]);
  await L.undoBatch(batchId);
  expect((await L.entry(ids.inn)).counterpart?.id).toBe(ids.out);
  expect((await L.entry(ids.inn)).kind).toBe("card_payment");
  expect((await L.entry(ids.out)).category).toBe("Fees");
});

it("does not bring back a duplicate the person deleted again after restoring it", async () => {
  const { L, batchId, ids } = await organized();
  await L.restoreEntries([ids.dupB]);
  await new Promise((resolve) => setTimeout(resolve, 5));
  await L.deleteEntries([ids.dupB]);
  await L.undoBatch(batchId);
  expect((await L.entry(ids.dupB)).deletedAt).not.toBeNull();
});

it("undoing twice changes nothing the second time", async () => {
  const { store, L, db, batchId } = await organized();
  expect(await L.undoBatch(batchId)).toBeGreaterThan(0);
  const once = await rowsOf(db);
  const [first] = (await store.transactions()).filter((t) => t.description.startsWith("STARBUCKS"));
  expect(await L.undoBatch(batchId)).toBe(0);
  expect(await rowsOf(db)).toBe(once);
  expect(first.category).toBe("Uncategorized");
});

it("respects later choices when undoing a run recorded by an earlier version (no expected values)", async () => {
  const { store, L, db } = await book();
  const [a, b] = (await store.transactions()).filter((t) => t.description.startsWith("STARBUCKS"));
  for (const row of [a, b]) {
    const [{ uuid }] = await db.select<{ uuid: string }>("SELECT uuid FROM transactions WHERE id = ?", [row.id]);
    await db.execute("UPDATE transactions SET category = 'Travel', category_source = 'ai' WHERE id = ?", [row.id]);
    await L.audit({ actor: "ai", action: "batch_update", subjectType: "transaction", subjectId: uuid, batchId: "legacy",
      undo: [{ op: "set", table: "transactions", id: row.id, fields: { category: "Uncategorized", category_source: "legacy" } }] });
  }
  await store.setCategory(a.id, "Business", false);
  await L.undoBatch("legacy");
  expect((await L.entry(a.id)).category).toBe("Business");
  expect((await L.entry(b.id)).category).toBe("Uncategorized");
});

it("writes a link and its undo record together or not at all", async () => {
  const { L, db, ids } = await book();
  const before = await rowsOf(db);
  // The audit record cannot be written (disk full, crash): the change it describes must not stay.
  await db.execute("CREATE TRIGGER qa_no_audit BEFORE INSERT ON audit_events BEGIN SELECT RAISE(ABORT, 'qa_no_audit'); END");
  await expect(L.linkTransfer(ids.out, ids.inn, "ai", "b", "ai")).rejects.toThrow();
  await expect(L.linkRefund(ids.refund, ids.purchase, "ai", "b", "ai")).rejects.toThrow();
  await expect(L.markDuplicate(ids.dupB, ids.dupA, "ai", "b", "ai")).rejects.toThrow();
  await expect(L.setKind(ids.refund, "refund", "ai", "b")).rejects.toThrow();
  await expect(L.batchUpdate([ids.dupA], { category: "Travel" }, "ai", "b")).rejects.toThrow();
  await expect(L.deleteEntries([ids.dupA], "ai", "b")).rejects.toThrow();
  expect(await rowsOf(db)).toBe(before);
  expect(await db.select("SELECT id FROM transaction_links")).toEqual([]);
});

it("never proposes a transfer or refund that would replace a category a person locked", async () => {
  const { store, db, ids } = await book();
  await store.setCategory(ids.out, "Shopping", false);
  await store.setCategory(ids.refund, "Gifts", false).catch(() => store.setCategory(ids.refund, "Business", false));
  const { proposals } = await analyze(store, db);
  expect(proposals.some((p) => (p.type === "transfer" || p.type === "card_payment") && p.outId === ids.out)).toBe(false);
  expect(proposals.some((p) => p.type === "refund" && p.refundId === ids.refund)).toBe(false);
});
