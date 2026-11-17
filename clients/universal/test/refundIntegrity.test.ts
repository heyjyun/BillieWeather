import { newStore } from "./helpers";

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
