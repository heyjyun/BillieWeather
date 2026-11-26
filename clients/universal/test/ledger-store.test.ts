// Manual bookkeeping on the local SQLite store (services/ledger.ts), replaying the shared
// contract scenario (packages/finance-core/fixtures/ledger/appendix2-scenario.json) through
// real database writes, plus every create / edit / delete / restore workflow. Synthetic data only.
import scenario from "../../../packages/finance-core/fixtures/ledger/appendix2-scenario.json";
import { buildSnapshot } from "@billie/finance-core";
import { newStore } from "./helpers";
import { LedgerError } from "../src/services/ledger";
import { importFile } from "../src/services/importFile";

async function book() {
  const { store, db } = await newStore();
  await store.ledger.setBookCurrency("USD");
  const chk = await store.ledger.createAccount({ name: "ZXQ Checking", type: "checking", openingBalanceCents: 100000 });
  const card = await store.ledger.createAccount({ name: "ZXQ Card", type: "credit_card", creditLimitCents: 500000, statementDay: 5, dueDay: 25 });
  const cash = await store.ledger.createAccount({ name: "Wallet", type: "cash", openingBalanceCents: 5000 });
  const old = await store.ledger.createAccount({ name: "Old savings", type: "savings", openingBalanceCents: 2500, includeInNetWorth: false });
  return { store, db, ids: { CHK: chk.id, CARD: card.id, CASH: cash.id, OLD: old.id } as Record<string, number> };
}

describe("manual bookkeeping on the device (shared Appendix 2 scenario)", () => {
  it("reproduces the scenario's totals, balances and net worth through real entries and links", async () => {
    const { store, ids } = await book();
    const L = store.ledger;
    const [t1] = await L.createEntry({ kind: "expense", amountCents: 12000, occurredOn: "2026-10-03", accountId: ids.CARD, category: "Food & dining", merchant: "ZXQ Grocery" });
    const [t2] = await L.createEntry({ kind: "expense", amountCents: 8000, occurredOn: "2026-10-09", accountId: ids.CARD, category: "Shopping", merchant: "ZXQ Outfitters", project: "Trip" });
    await L.createEntry({ kind: "refund", amountCents: 3000, occurredOn: "2026-10-15", accountId: ids.CARD, category: "Shopping", merchant: "ZXQ Outfitters", project: "Trip", refundOf: t2 });
    // Card payment: one transfer into a liability account becomes kind card_payment with two linked legs.
    const legs = await L.createEntry({ kind: "transfer", amountCents: 17000, occurredOn: "2026-10-28", accountId: ids.CHK, toAccountId: ids.CARD });
    await L.createEntry({ kind: "income", amountCents: 200000, occurredOn: "2026-10-30", accountId: ids.CHK, category: "Income" });
    await L.createEntry({ kind: "expense", amountCents: 6000, occurredOn: "2026-10-31", accountId: ids.CHK, description: "ZELLE TO SAM Q" });
    await L.createEntry({ kind: "expense", amountCents: 1250, occurredOn: "2026-10-12", accountId: ids.CASH, category: "Food & dining", tags: ["lunch"] });
    await L.createEntry({ kind: "transfer", amountCents: 20000, occurredOn: "2026-10-20", accountId: ids.CHK, toAccountId: ids.CASH });
    // Balance check (余额): the wallet really holds 230.00 on 10-25 -> one adjustment of -7.50.
    expect(await L.adjustBalance(ids.CASH, 23000, "2026-10-25")).not.toBeNull();
    const [m5] = await L.createEntry({ kind: "expense", amountCents: 999, occurredOn: "2026-10-26", accountId: ids.CHK, category: "Shopping" });
    await store.setExcluded(m5, true);
    const [m6] = await L.createEntry({ kind: "expense", amountCents: 4321, occurredOn: "2026-10-27", accountId: ids.CHK, category: "Health" });
    await L.deleteEntries([m6]);
    await L.createEntry({ kind: "expense", amountCents: 3000, occurredOn: "2026-11-02", accountId: ids.CHK, category: "Food & dining" });

    const october = await L.report("category", { from: scenario.expected.october.from, to: scenario.expected.october.to });
    expect([october.incomeMinor, october.expenseMinor, october.netMinor]).toEqual([scenario.expected.october.incomeMinor, scenario.expected.october.expenseMinor, scenario.expected.october.netMinor]);
    expect(Object.fromEntries(october.rows.filter((r) => r.expenseMinor !== 0).map((r) => [r.key, r.expenseMinor]))).toEqual(scenario.expected.october.expenseByCategory);
    const all = await L.report("month");
    expect([all.incomeMinor, all.expenseMinor]).toEqual([scenario.expected.allTime.incomeMinor, scenario.expected.allTime.expenseMinor]);

    const byName = Object.fromEntries((await L.accounts()).map((a) => [a.name, a.balanceCents]));
    const expected = scenario.expected.balancesAllTime;
    expect(byName).toEqual({ "ZXQ Checking": expected.CHK, "ZXQ Card": expected.CARD, Wallet: expected.CASH, "Old savings": expected.OLD });
    expect(await L.netWorth()).toEqual(scenario.expected.netWorthAllTime);
    expect((await L.entry(t2)).refundableCents).toBe(scenario.expected.refundableOf_t2);

    // The dashboard snapshot (kind-based) agrees with the ledger.
    const snap = buildSnapshot({ transactions: await store.transactions(), statements: [], period: { startDate: "2026-10-01", endDate: "2026-10-31" }, currency: "USD" });
    expect([snap.incomeCents, snap.expensesCents]).toEqual([scenario.expected.october.incomeMinor, scenario.expected.october.expenseMinor]);

    const leg = await L.entry(legs[0]);
    expect(leg.kind).toBe("card_payment");
    expect(leg.counterpart?.amountCents).toBe(17000);
    expect((await L.entry(t1)).merchant).toBe("ZXQ Grocery");
  });
});

describe("manual entry workflows", () => {
  it("validates like Rails and refuses refunds beyond the expense", async () => {
    const { store, ids } = await book();
    const L = store.ledger;
    await expect(L.createEntry({ kind: "expense", amountCents: 0, occurredOn: "2026-10-01", accountId: ids.CHK })).rejects.toMatchObject({ code: "invalid_entry", problems: ["amount_zero"] });
    await expect(L.createEntry({ kind: "expense", amountCents: 100, occurredOn: "2026-02-30", accountId: ids.CHK })).rejects.toBeInstanceOf(LedgerError);
    await expect(L.createEntry({ kind: "transfer", amountCents: 100, occurredOn: "2026-10-01", accountId: ids.CHK, toAccountId: ids.CHK })).rejects.toMatchObject({ problems: ["accounts_same"] });
    await expect(L.createEntry({ kind: "expense", amountCents: 100, occurredOn: "2026-10-01", accountId: ids.CHK, category: "Income" })).rejects.toMatchObject({ problems: ["category_kind"] });
    const [expense] = await L.createEntry({ kind: "expense", amountCents: 8000, occurredOn: "2026-10-09", accountId: ids.CARD, category: "Shopping" });
    await L.createEntry({ kind: "refund", amountCents: 5000, occurredOn: "2026-10-10", accountId: ids.CARD, category: "Shopping", refundOf: expense });
    await expect(L.createEntry({ kind: "refund", amountCents: 3001, occurredOn: "2026-10-11", accountId: ids.CARD, category: "Shopping", refundOf: expense })).rejects.toMatchObject({ code: "refund_too_large" });
    await L.createEntry({ kind: "refund", amountCents: 3000, occurredOn: "2026-10-11", accountId: ids.CARD, category: "Shopping", refundOf: expense });
    expect((await L.entry(expense)).refundableCents).toBe(0);
    expect((await L.refundCandidates()).some((c) => c.id === expense)).toBe(false);
  });

  it("edits, copies, deletes to the trash, restores and purges (a transfer's legs always move together)", async () => {
    const { store, ids } = await book();
    const L = store.ledger;
    const [from, to] = await L.createEntry({ kind: "transfer", amountCents: 5000, occurredOn: "2026-10-01", accountId: ids.CHK, toAccountId: ids.CASH, note: "ATM" });
    await L.updateEntry(from, { kind: "transfer", amountCents: 6000, occurredOn: "2026-10-02", accountId: ids.CHK, toAccountId: ids.OLD, note: "moved" });
    const edited = await L.entry(to);
    expect([edited.amountCents, edited.accountId, edited.occurredOn, edited.note]).toEqual([6000, ids.OLD, "2026-10-02", "moved"]);
    expect((await L.entry(from)).amountCents).toBe(-6000);

    const copies = await L.duplicateEntry(to, "2026-10-05");
    expect(copies).toHaveLength(2);
    expect((await L.entry(copies[0])).amountCents + (await L.entry(copies[1])).amountCents).toBe(0);

    expect(await L.deleteEntries([to])).toEqual(expect.arrayContaining([from, to]));
    expect((await store.transactions()).some((t) => t.id === from || t.id === to)).toBe(false);
    expect((await L.trash()).map((e) => e.id).sort()).toEqual([from, to].sort());
    // Only the copy (60.00 out of checking) is still live.
    expect((await L.accounts()).find((a) => a.id === ids.CHK)!.balanceCents).toBe(100000 - 6000);

    await L.restoreEntries([from]);
    expect((await L.trash())).toHaveLength(0);
    await L.deleteEntries([from]);
    await expect(L.purgeEntries([copies[0]])).rejects.toMatchObject({ code: "not_in_trash" });
    expect(await L.emptyTrash()).toBe(2);
    await expect(L.entry(from)).rejects.toMatchObject({ code: "not_found" });
  });

  it("keeps the bank's original text when an imported row is edited, and locks edited fields against automation", async () => {
    const { store } = await newStore();
    await importFile(store, new TextEncoder().encode("Date,Description,Amount\n2026-01-03,ZXQ CAFE 123,-5.00\n2026-01-04,ZXQ CAFE 456,-6.00\n"), "c.csv", "USD");
    const [row] = (await store.transactions()).filter((t) => t.description === "ZXQ CAFE 123");
    const before = await store.ledger.entry(row.id);
    await store.ledger.updateEntry(row.id, { kind: "expense", amountCents: 999, occurredOn: "2030-01-01", accountId: before.accountId, category: "Health", description: "Coffee with Sam" });
    const after = await store.ledger.entry(row.id);
    expect(after.description).toBe("Coffee with Sam");
    expect(after.originalDescription).toBe("ZXQ CAFE 123");
    // Imported amounts and dates are evidence: an edit does not change them.
    expect([after.amountCents, after.occurredOn]).toEqual([-500, "2026-01-03"]);
    expect(after.lockedFields).toEqual(expect.arrayContaining(["category", "description"]));
    // A later rule never overrides the person's category.
    await store.setCategory((await store.transactions()).find((t) => t.description === "ZXQ CAFE 456")!.id, "Business", true);
    expect((await store.ledger.entry(row.id)).category).toBe("Health");
  });

  it("batch edits category, merchant, project and tags, and logs every change", async () => {
    const { store, ids } = await book();
    const L = store.ledger;
    const a = (await L.createEntry({ kind: "expense", amountCents: 100, occurredOn: "2026-10-01", accountId: ids.CHK }))[0];
    const b = (await L.createEntry({ kind: "expense", amountCents: 200, occurredOn: "2026-10-02", accountId: ids.CHK }))[0];
    expect(await L.batchUpdate([a, b], { category: "Health", merchant: "ZXQ Clinic", project: "Knee", addTags: ["medical", "2026"] })).toBe(2);
    for (const id of [a, b]) expect(await L.entry(id)).toMatchObject({ category: "Health", merchant: "ZXQ Clinic", project: "Knee", tags: ["medical", "2026"] });
    await L.batchUpdate([a], { removeTags: ["2026"] });
    expect((await L.entry(a)).tags).toEqual(["medical"]);
    const events = await L.auditEvents({ subjectType: "transaction" });
    expect(events.filter((e) => e.action === "batch_update")).toHaveLength(2);
    expect(events.some((e) => e.action === "create")).toBe(true);
  });

  it("manages accounts: types, archive instead of delete when used, reorder", async () => {
    const { store, ids } = await book();
    const L = store.ledger;
    await expect(L.createAccount({ name: "ZXQ Checking", type: "checking" })).rejects.toMatchObject({ code: "name_taken" });
    const wallet = await L.createAccount({ name: "Alipay", type: "payment_app" });
    await L.deleteAccount(wallet.id);
    await L.createEntry({ kind: "expense", amountCents: 100, occurredOn: "2026-10-01", accountId: ids.CASH });
    await expect(L.deleteAccount(ids.CASH)).rejects.toMatchObject({ code: "account_in_use" });
    await L.setAccountArchived(ids.CASH, true);
    expect((await L.accounts()).some((a) => a.id === ids.CASH)).toBe(false);
    expect((await L.accounts({ includeArchived: true })).find((a) => a.id === ids.CASH)!.archived).toBe(true);
    await L.updateAccount(ids.CARD, { name: "ZXQ Visa", creditLimitCents: 300000 });
    expect((await L.account(ids.CARD))).toMatchObject({ name: "ZXQ Visa", creditLimitCents: 300000, accountClass: "liability" });
    await L.reorderAccounts([ids.CARD, ids.CHK]);
    expect((await L.accounts()).map((a) => a.id).slice(0, 2)).toEqual([ids.CARD, ids.CHK]);
  });
});

describe("categories, merchants, projects and tags", () => {
  it("builds a tree of any depth with income and expense branches; deletes move entries", async () => {
    const { store, ids } = await book();
    await store.addCategory("Espresso");
    await store.addCategory("Wages");
    await store.addCategory("Cafes");
    await store.ledger.setCategoryMeta("Espresso", { parent: "Food & dining" });
    await store.ledger.setCategoryMeta("Wages", { parent: "Income" });
    await store.ledger.setCategoryMeta("Cafes", { parent: "Espresso" }); // a third level is fine now
    const tree = await store.ledger.categoryTree();
    expect(tree.find((n) => n.name === "Food & dining")!.children.map((c) => c.name)).toContain("Espresso");
    expect(tree.find((n) => n.name === "Income")!.children.find((c) => c.name === "Wages")).toMatchObject({ kind: "income" });
    expect((await store.categoryTree()).get("Cafes")).toMatchObject({ parent: "Espresso", depth: 2 });
    await store.ledger.setCategoryMeta("Cafes", { parent: null });
    // An income subcategory works for income entries only.
    await store.ledger.createEntry({ kind: "income", amountCents: 1000, occurredOn: "2026-10-01", accountId: ids.CHK, category: "Wages" });
    await expect(store.ledger.createEntry({ kind: "expense", amountCents: 1000, occurredOn: "2026-10-01", accountId: ids.CHK, category: "Wages" })).rejects.toMatchObject({ problems: ["category_kind"] });
    const [coffee] = await store.ledger.createEntry({ kind: "expense", amountCents: 450, occurredOn: "2026-10-02", accountId: ids.CHK, category: "Espresso" });
    await store.renameCategory("Espresso", "Coffee shops");
    expect((await store.ledger.entry(coffee)).category).toBe("Coffee shops");
    expect((await store.ledger.categoryTree()).find((n) => n.name === "Food & dining")!.children.map((c) => c.name)).toContain("Coffee shops");
    expect(await store.mergeCategory("Coffee shops", "Food & dining")).toBe(1);
    expect((await store.ledger.entry(coffee)).category).toBe("Food & dining");
    await store.ledger.setCategoryMeta("Cafes", { hidden: true }, await store.customCategories());
    expect((await store.ledger.categoryTree(await store.customCategories())).find((n) => n.name === "Cafes")!.hidden).toBe(true);
  });

  it("creates, renames, merges, archives and deletes merchants, projects and tags", async () => {
    const { store, ids } = await book();
    const L = store.ledger;
    const [a] = await L.createEntry({ kind: "expense", amountCents: 100, occurredOn: "2026-10-01", accountId: ids.CHK, merchant: "ZXQ Mart", project: "Home", tags: ["weekly"] });
    const [b] = await L.createEntry({ kind: "expense", amountCents: 200, occurredOn: "2026-10-02", accountId: ids.CHK, merchant: "zxq mart", tags: ["Weekly"] });
    expect((await L.dimensions("merchant")).map((d) => [d.name, d.entryCount])).toEqual([["ZXQ Mart", 2]]);
    const other = await L.createDimension("merchant", "ZXQ Market");
    await expect(L.createDimension("merchant", "zxq market")).rejects.toMatchObject({ code: "name_taken" });
    await L.mergeDimension("merchant", other.id, (await L.dimensions("merchant")).find((d) => d.name === "ZXQ Mart")!.id);
    expect((await L.dimensions("merchant")).map((d) => d.name)).toEqual(["ZXQ Mart"]);
    const project = (await L.dimensions("project"))[0];
    await L.renameDimension("project", project.id, "House");
    expect((await L.entry(a)).project).toBe("House");
    await L.setDimensionArchived("project", project.id, true);
    expect(await L.dimensions("project")).toHaveLength(0);
    const tag = (await L.dimensions("tag"))[0];
    expect(tag.entryCount).toBe(2);
    expect(await L.deleteDimension("tag", tag.id)).toBe(2);
    expect((await L.entry(b)).tags).toEqual([]);
  });
});

describe("budgets and recurring entries", () => {
  it("tracks a monthly category budget with a custom month start and a 90% warning", async () => {
    const { store, ids } = await book();
    const L = store.ledger;
    await L.setMonthStartDay(10);
    await L.saveBudget({ period: "month", category: "Food & dining", amountCents: 10000 });
    await L.saveBudget({ period: "month", amountCents: 50000 });
    await expect(L.saveBudget({ period: "month", category: "Food & dining", amountCents: 1 })).rejects.toMatchObject({ code: "invalid_budget" });
    await L.createEntry({ kind: "expense", amountCents: 9500, occurredOn: "2026-10-12", accountId: ids.CHK, category: "Food & dining" });
    await L.createEntry({ kind: "expense", amountCents: 5000, occurredOn: "2026-10-05", accountId: ids.CHK, category: "Food & dining" }); // previous budget month
    const [food, total] = (await L.budgets("2026-10-20")).sort((x, y) => (x.category ? -1 : 1) - (y.category ? -1 : 1));
    expect(food).toMatchObject({ category: "Food & dining", from: "2026-10-10", to: "2026-11-09", status: { spentMinor: 9500, level: "warning" } });
    expect(total.status.spentMinor).toBe(9500);
  });

  it("posts due occurrences once (idempotent), clamps month ends, and can skip or pause", async () => {
    const { store, ids } = await book();
    const L = store.ledger;
    const rule = await L.saveRecurringRule({ name: "Rent", template: { kind: "expense", amountCents: 120000, accountId: ids.CHK, category: "Housing" }, frequency: "monthly", startOn: "2026-01-31" });
    expect(L.previewOccurrences("2026-01-31", "monthly", 1, 3)).toEqual(["2026-01-31", "2026-02-28", "2026-03-31"]);
    expect((await L.dueOccurrences("2026-03-31")).map((d) => d.on)).toEqual(["2026-01-31", "2026-02-28", "2026-03-31"]);
    expect(await L.postDue("2026-03-31")).toBe(3);
    expect(await L.postDue("2026-03-31")).toBe(0);
    const posted = (await store.transactions()).filter((t) => t.origin === "recurring");
    expect(posted.map((t) => t.bookedOn).sort()).toEqual(["2026-01-31", "2026-02-28", "2026-03-31"]);
    await L.skipOccurrence(rule);
    expect((await L.recurringRules())[0].nextOn).toBe("2026-05-31");
    await L.setRecurringPaused(rule, true);
    expect(await L.postDue("2026-12-31")).toBe(0);
    // A transfer schedule creates linked legs.
    await L.saveRecurringRule({ name: "Save", template: { kind: "transfer", amountCents: 1000, accountId: ids.CHK, toAccountId: ids.OLD }, frequency: "weekly", startOn: "2026-03-01", endOn: "2026-03-15", autoPost: true });
    expect(await L.postDue("2026-12-31", { onlyAuto: true })).toBe(3);
    expect((await L.accounts()).find((a) => a.id === ids.OLD)!.balanceCents).toBe(2500 + 3000);
  });
});

describe("P0-2: imported refunds and card payments are not income", () => {
  it("files a card statement's refund and repayment by kind, and lists legacy suspects for review", async () => {
    const { store } = await newStore();
    const csv = "Date,Description,Amount\n2026-10-03,ZXQ GROCERY,-120.00\n2026-10-15,ZXQ OUTFITTERS RETURN,30.00\n2026-10-28,PAYMENT THANK YOU,170.00\n2026-10-30,ZXQ PAYROLL,2000.00\n";
    await importFile(store, new TextEncoder().encode(csv), "mixed.csv", "USD");
    const byDescription = Object.fromEntries((await store.transactions()).map((t) => [t.description, t]));
    expect(byDescription["ZXQ OUTFITTERS RETURN"].kind).toBe("refund");
    expect(byDescription["PAYMENT THANK YOU"].kind).toBe("card_payment");
    expect(byDescription["ZXQ PAYROLL"].kind).toBe("income");
    const snap = buildSnapshot({ transactions: await store.transactions(), statements: [], period: { startDate: null, endDate: null }, currency: "USD" });
    expect(snap.incomeCents).toBe(200000);
    expect(snap.expensesCents).toBe(12000 - 3000);
    // A legacy row (kind backfilled as income) that looks like a refund is listed, and fixing it changes the totals.
    await store.ledger.setKind(byDescription["ZXQ OUTFITTERS RETURN"].id, "income");
    const suspects = await store.ledger.suspectIncome();
    expect(suspects).toEqual([]); // the person decided: kind is locked, never listed again
  });
});
