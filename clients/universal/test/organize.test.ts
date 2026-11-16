// "Organize my finances with AI": Analyze -> Preview -> Approve -> Apply -> Undo, on the same
// financial model as manual entries. A person's locked choices are never proposed or changed.
import { newStore } from "./helpers";
import { analyze, applyProposals, undoRun } from "../src/services/organize";
import { importFile } from "../src/services/importFile";

async function messyBook() {
  const { store } = await newStore();
  await store.ledger.setBookCurrency("USD");
  const chk = await store.ledger.createAccount({ name: "ZXQ Checking", type: "checking" });
  const card = await store.ledger.createAccount({ name: "ZXQ Card", type: "credit_card" });
  const L = store.ledger;
  // Rows as an import would leave them: Uncategorized, unlinked, a duplicate, a refund counted as income.
  // Imported before the keyword lists knew this merchant: still Uncategorized.
  await importFile(store, new TextEncoder().encode("Date,Description,Amount\n2026-10-01,STARBUCKS STORE 12,-5.00\n2026-10-08,STARBUCKS STORE 99,-4.00\n"), "s.csv", "USD");
  await store.sql.execute("UPDATE transactions SET category = 'Uncategorized', category_source = 'legacy' WHERE description LIKE 'STARBUCKS%'");
  const [purchase] = await L.createEntry({ kind: "expense", amountCents: 8000, occurredOn: "2026-10-09", accountId: card.id, description: "ZXQ OUTFITTERS" });
  const db = store.sql;
  const insert = async (account: number, date: string, description: string, cents: number, kind: string, category: string) => {
    await db.execute("INSERT INTO transactions (statement_id, account_id, booked_on, description, amount_cents, category, kind, entry_origin, updated_at) VALUES ((SELECT MIN(id) FROM statements), ?, ?, ?, ?, ?, ?, 'import', 'x')",
      [account, date, description, cents, category, kind]);
    return Number((await db.select<{ id: number }>("SELECT MAX(id) AS id FROM transactions"))[0].id);
  };
  const refund = await insert(card.id, "2026-10-15", "ZXQ OUTFITTERS RETURN", 3000, "income", "Income");
  const out = await insert(chk.id, "2026-10-28", "ONLINE PMT TO CARD", -17000, "expense", "Uncategorized");
  const inn = await insert(card.id, "2026-10-29", "PAYMENT RECEIVED", 17000, "income", "Income");
  const dupA = await insert(chk.id, "2026-10-20", "ZXQ GYM", -3000, "expense", "Health");
  const dupB = await insert(chk.id, "2026-10-20", "ZXQ GYM", -3000, "expense", "Health");
  return { store, db, ids: { purchase, refund, out, inn, dupA, dupB }, accounts: { chk: chk.id, card: card.id } };
}

describe("Organize my finances", () => {
  it("proposes, applies only what was approved as one audited batch, and undoes it completely", async () => {
    const { store, db, ids } = await messyBook();
    const before = JSON.stringify(await store.transactions());
    const beforeTotals = await store.ledger.report("category");
    const { runId, proposals } = await analyze(store, db);
    const types = proposals.map((p) => p.type);
    expect(types).toEqual(expect.arrayContaining(["card_payment", "refund", "duplicate", "categorize"]));
    // Analyze changes nothing.
    expect(JSON.stringify(await store.transactions())).toBe(before);

    const approved = proposals.filter((p) => p.type !== "merchant");
    const { batchId, applied } = await applyProposals(store, db, runId, approved);
    expect(applied).toBeGreaterThanOrEqual(4);
    expect((await store.ledger.entry(ids.out)).kind).toBe("card_payment");
    expect((await store.ledger.entry(ids.inn)).counterpart?.id).toBe(ids.out);
    expect((await store.ledger.entry(ids.refund)).refundOf?.id).toBe(ids.purchase);
    expect((await store.ledger.entry(ids.dupB)).deletedAt).not.toBeNull();
    const starbucks = (await store.transactions()).filter((t) => t.description.startsWith("STARBUCKS"));
    expect(starbucks.every((t) => t.category === "Food & dining" && t.categorySource === "ai")).toBe(true);
    // Income no longer counts the refund or the card payment.
    const after = await store.ledger.report("category");
    expect(after.incomeMinor).toBe(beforeTotals.incomeMinor - 3000 - 17000);
    // Every change is in the activity log under the batch.
    expect((await store.ledger.auditEvents({ batchId })).length).toBeGreaterThanOrEqual(4);

    await undoRun(store, db, batchId);
    const restored = (await store.transactions()).map(({ id, kind, category, excluded }) => ({ id, kind, category, excluded }));
    const original = (JSON.parse(before) as Array<{ id: number; kind: string; category: string; excluded: boolean }>).map(({ id, kind, category, excluded }) => ({ id, kind, category, excluded }));
    expect(restored).toEqual(original);
    expect((await store.ledger.entry(ids.inn)).counterpart).toBeNull();
    expect((await store.ledger.report("category")).incomeMinor).toBe(beforeTotals.incomeMinor);
  });

  it("never proposes changes to what a person chose, and skips proposals that no longer apply", async () => {
    const { store, db, ids } = await messyBook();
    const [first] = (await store.transactions()).filter((t) => t.description === "STARBUCKS STORE 12");
    await store.setCategory(first.id, "Business", false); // the person's choice: locked
    await store.ledger.setKind(ids.refund, "income"); // the person says this really is income
    const { runId, proposals } = await analyze(store, db);
    expect(proposals.some((p) => p.type === "categorize" && p.ids.includes(first.id))).toBe(false);
    expect(proposals.some((p) => p.type === "refund" && p.refundId === ids.refund)).toBe(false);
    expect(proposals.some((p) => p.type === "suspect_income" && p.entryId === ids.refund)).toBe(false);
    // The row changes between preview and apply: the stale proposal is skipped, the rest apply.
    const transfer = proposals.find((p) => p.type === "card_payment")!;
    await store.ledger.deleteEntries([ids.out]);
    const { applied } = await applyProposals(store, db, runId, [transfer, ...proposals.filter((p) => p.type === "duplicate")]);
    expect(applied).toBe(1);
    expect((await store.ledger.entry(first.id)).category).toBe("Business");
  });

  it("can ask BillieWeather AI for categories with cleaned merchant text only", async () => {
    const { store, db } = await messyBook();
    await importFile(store, new TextEncoder().encode("Date,Description,Amount\n2026-11-01,ZQX OBSCURE MERCHANT #4411 a@b.co,-9.99\n"), "o.csv", "USD");
    const sent: unknown[] = [];
    const { proposals } = await analyze(store, db, { cloud: async (items) => { sent.push(...items); return items.map((item) => ({ key: item.key, category: "Shopping" })); } });
    expect(JSON.stringify(sent)).not.toMatch(/4411|a@b\.co|9\.99|999/);
    expect(sent).toEqual(expect.arrayContaining([expect.objectContaining({ text: "ZQX OBSCURE MERCHANT", direction: "out" })]));
    expect(proposals.some((p) => p.type === "categorize" && p.reason === "ai" && p.category === "Shopping")).toBe(true);
  });
});
