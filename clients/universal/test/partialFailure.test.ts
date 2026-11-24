// A failure part-way (disk full, crash) leaves multi-step changes completely undone.
import { newStore } from "./helpers";
import { importFile } from "../src/services/importFile";

const dump = async (store: Awaited<ReturnType<typeof newStore>>["store"]) => JSON.stringify(await Promise.all(
  ["transactions", "transaction_links", "transaction_tags", "statements", "merchants", "tags", "settings"].map((table) => store.sql.select(`SELECT * FROM ${table} ORDER BY 1`))));
const fail = (store: Awaited<ReturnType<typeof newStore>>["store"], event: string) =>
  store.sql.execute(`CREATE TRIGGER qa_fail BEFORE ${event} BEGIN SELECT RAISE(ABORT, 'qa_fail'); END`);

async function book() {
  const { store } = await newStore();
  const L = store.ledger;
  await L.setBookCurrency("USD");
  const a = await L.createAccount({ name: "A", type: "checking" });
  const b = await L.createAccount({ name: "B", type: "savings" });
  const [out, inn] = await L.createEntry({ kind: "transfer", amountCents: 1000, occurredOn: "2026-10-01", accountId: a.id, toAccountId: b.id });
  const [one] = await L.createEntry({ kind: "expense", amountCents: 500, occurredOn: "2026-10-02", accountId: a.id, description: "Synthetic", merchant: "M1", tags: ["t1"] });
  await L.createEntry({ kind: "expense", amountCents: 700, occurredOn: "2026-10-03", accountId: a.id, description: "Synthetic", merchant: "M2", tags: ["t2"] });
  return { store, L, a, b, out, inn, one };
}

it("purging keeps links and tags when the entries cannot be deleted", async () => {
  const { store, L, out } = await book();
  await L.deleteEntries([out]);
  const before = await dump(store);
  await fail(store, "DELETE ON transactions");
  await expect(L.purgeEntries([out])).rejects.toThrow();
  expect(await dump(store)).toBe(before);
});

it("merging and deleting merchants and tags is all or nothing", async () => {
  const { store, L } = await book();
  const [m1, m2] = await L.dimensions("merchant");
  const [t1, t2] = await L.dimensions("tag");
  const before = await dump(store);
  await fail(store, "INSERT ON audit_events");
  await expect(L.mergeDimension("merchant", m1.id, m2.id)).rejects.toThrow();
  await expect(L.mergeDimension("tag", t1.id, t2.id)).rejects.toThrow();
  await expect(L.deleteDimension("merchant", m1.id)).rejects.toThrow();
  await expect(L.deleteDimension("tag", t1.id)).rejects.toThrow();
  expect(await dump(store)).toBe(before);
  await store.sql.execute("DROP TRIGGER qa_fail");
  expect(await L.mergeDimension("merchant", m1.id, m2.id)).toBe(1);
  expect(await L.deleteDimension("tag", t1.id)).toBe(1);
});

it("editing a transfer changes both legs and the link together", async () => {
  const { store, L, a, b, out } = await book();
  const before = await dump(store);
  await fail(store, "UPDATE ON transaction_links");
  await expect(L.updateEntry(out, { kind: "transfer", amountCents: 2000, occurredOn: "2026-10-01", accountId: a.id, toAccountId: b.id })).rejects.toThrow();
  expect(await dump(store)).toBe(before);
});

it("reversing an import of several statements removes all of them or none", async () => {
  const { store } = await newStore();
  await store.ledger.setBookCurrency("USD");
  for (const day of ["01", "02"]) await importFile(store, new TextEncoder().encode(`Date,Description,Amount\n2026-10-${day},SYNTHETIC ${day},-5.00\n`), `${day}.csv`, "USD");
  const ids = (await store.statements()).map((statement) => statement.id);
  expect(ids).toHaveLength(2);
  const before = await dump(store);
  await store.sql.execute(`CREATE TRIGGER qa_fail BEFORE DELETE ON statements WHEN OLD.id = ${ids[1]} BEGIN SELECT RAISE(ABORT, 'qa_fail'); END`);
  await expect(store.reverseImport(ids)).rejects.toThrow();
  expect(await dump(store)).toBe(before);
  await store.sql.execute("DROP TRIGGER qa_fail");
  expect(await store.reverseImport(ids)).toBe(2);
  expect(await store.statements()).toEqual([]);
});

it("setting one category on many entries is all or nothing", async () => {
  const { store, one } = await book();
  const ids = (await store.transactions()).map((transaction) => transaction.id);
  await store.sql.execute(`CREATE TRIGGER qa_fail BEFORE UPDATE OF category ON transactions WHEN OLD.id = ${one} BEGIN SELECT RAISE(ABORT, 'qa_fail'); END`);
  const before = await dump(store);
  await expect(store.setCategoryMany(ids, "Travel")).rejects.toThrow();
  expect(await dump(store)).toBe(before);
});
