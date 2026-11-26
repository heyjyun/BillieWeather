// The category tree on the device (migration 0011, docs/architecture/category-hierarchy.md): seeding,
// the legacy migration, "Add suggested categories", any depth, cycles, kinds, rename/delete/merge,
// Transfers, roll-ups, key resolution, AI proposals, web sync, upload payload and expansion. Synthetic data only.
import initSqlJs from "sql.js";
import { aiGroups, flatDefaultCategories, parseAiProposals, type CategoryRow } from "@billie/finance-core";
import { migrate, newStore } from "./helpers";
import { sqljsDriver } from "../src/services/sqljsDriver";
import { FinanceStore } from "../src/services/store";
import { recordedStore } from "../src/services/history/recorded";
import { matchTransactions } from "../src/commands/handlers";
import { uploadStatement } from "../src/services/cloudUpload";
import { importFile } from "../src/services/importFile";

const row = (rows: CategoryRow[], name: string) => rows.find((item) => item.name === name);

async function book() {
  const { store, db } = await newStore();
  await store.ledger.setBookCurrency("USD");
  const account = await store.ledger.createAccount({ name: "ZXQ Checking", type: "checking", openingBalanceCents: 100000 });
  const spend = async (category: string, cents: number, description = `ZXQ ${category}`) =>
    (await store.ledger.createEntry({ kind: "expense", amountCents: cents, occurredOn: "2026-11-10", accountId: account.id, category, description }))[0];
  return { store, db, account, spend };
}

/** A version-10 book as that version wrote it, then migrated to the current schema. */
async function legacyBook(seed: (db: import("sql.js").Database) => void) {
  const SQL = await initSqlJs();
  const db = new SQL.Database();
  migrate(db, 10);
  seed(db);
  migrate(db);
  return { db, store: new FinanceStore(sqljsDriver(db)) };
}

describe("seeding and the legacy migration", () => {
  it("seeds a fresh book with the 14 default roots and 70 subcategories, once", async () => {
    const { store, db } = await newStore();
    const rows = await store.categoryRows();
    expect(rows.filter((item) => item.parent === null)).toHaveLength(14);
    expect(rows.filter((item) => item.parent !== null)).toHaveLength(70);
    expect(rows.every((item) => item.key !== null)).toBe(true);
    expect(row(rows, "Groceries")).toMatchObject({ parent: "Food & dining", key: "food.groceries", kind: "expense", expanded: false });
    expect(row(rows, "Account transfer")).toMatchObject({ parent: "Transfers", kind: "transfer" });
    expect(db.exec("SELECT value FROM settings WHERE key = 'category_seed'")[0].values).toEqual([["defaults"]]);
    await store.ensureCategorySeed();
    expect(await store.categoryRows()).toHaveLength(84);
    expect(await store.hasContent()).toBe(false); // the defaults alone are not content
  });

  it("keeps an existing book's structure exactly and adds nothing new", async () => {
    const { db, store } = await legacyBook((db) => {
      db.exec(`INSERT INTO statements (id, filename, currency, sha256, transaction_count, imported_at) VALUES (1, 's.csv', 'USD', 's', 1, '2026-11-20');
        INSERT INTO transactions (statement_id, booked_on, description, amount_cents, category, updated_at) VALUES (1, '2026-11-20', 'ZXQ Pet', -900, 'Pets', 'x');
        INSERT INTO custom_categories (name, created_at) VALUES ('Pets', 'c1'), ('Side gigs', 'c2'), ('Tips', 'c3'), ('Old stuff', 'c4');
        INSERT INTO category_meta (name, parent, category_kind, sort_order, hidden, updated_at) VALUES
          ('Pets', 'Food & dining', 'expense', 2, 0, 'x'), ('Side gigs', NULL, 'income', 1, 0, 'x'), ('Tips', 'Side gigs', 'expense', 1, 0, 'x'),
          ('Old stuff', NULL, 'expense', 5, 1, 'x'), ('Housing', NULL, 'expense', 3, 1, 'x');`);
    });
    const rows = await store.categoryRows();
    expect(rows.map((item) => item.name).sort()).toEqual(["Business", "Food & dining", "Health", "Housing", "Income", "Old stuff", "Pets", "Shopping", "Side gigs", "Tips", "Transfers", "Transport", "Utilities"]);
    expect(row(rows, "Income")).toMatchObject({ key: "income", kind: "income", parent: null });
    expect(row(rows, "Transfers")).toMatchObject({ key: "transfers", kind: "transfer" });
    expect(row(rows, "Housing")).toMatchObject({ key: "housing", hidden: true, sortOrder: 3 });
    expect(row(rows, "Pets")).toMatchObject({ key: null, parent: "Food & dining", kind: "expense", sortOrder: 2 });
    expect(row(rows, "Tips")).toMatchObject({ parent: "Side gigs", kind: "income" }); // a child has its parent's tree
    expect(row(rows, "Old stuff")).toMatchObject({ parent: null, hidden: true, sortOrder: 5 });
    expect(db.exec("SELECT value FROM settings WHERE key = 'category_seed'")[0].values).toEqual([["legacy"]]);
    await store.ensureCategorySeed();
    expect(await store.categoryRows()).toHaveLength(13);
  });

  it("an unused version-10 book is seeded with the defaults when it opens", async () => {
    const { store } = await legacyBook(() => undefined);
    expect(await store.categoryRows()).toHaveLength(84);
  });

  it("Add suggested categories adds only what is missing, by key then name (any case), and is idempotent", async () => {
    const { store } = await legacyBook((db) => {
      db.exec(`INSERT INTO custom_categories (name, created_at) VALUES ('groceries', 'c'), ('Vacations', 'c');
        INSERT INTO category_meta (name, parent, category_kind, sort_order, hidden, updated_at) VALUES ('groceries', 'Shopping', 'expense', 1, 0, 'x');`);
    });
    await store.renameCategory("Housing", "Home");
    const added = await store.addSuggestedCategories();
    const rows = await store.categoryRows();
    // 84 defaults; Home (key housing), groceries (by name) and the other 8 legacy ones are there already.
    expect(added).toHaveLength(84 - 10);
    expect(added).not.toContain("Housing");
    expect(added).not.toContain("Groceries");
    expect(rows.filter((item) => item.name.toLowerCase() === "groceries")).toHaveLength(1);
    expect(row(rows, "groceries")).toMatchObject({ parent: "Shopping", key: "food.groceries" }); // never moved, never renamed
    expect(row(rows, "Rent")).toMatchObject({ parent: "Home", kind: "expense" }); // under the category holding the parent's key
    expect(row(rows, "Entertainment")).toMatchObject({ parent: null, key: "entertainment" });
    expect(row(rows, "Movies & events")).toMatchObject({ parent: "Entertainment" });
    expect(row(rows, "Vacations")).toMatchObject({ parent: null, key: null });
    expect(await store.addSuggestedCategories()).toEqual([]);
    expect(await store.categoryRows()).toHaveLength(rows.length);
  });
});

describe("the tree", () => {
  it("nests six levels deep and gives paths", async () => {
    const { store } = await newStore();
    let parent = "Groceries";
    for (const name of ["L3", "L4", "L5", "L6", "L7"]) {
      await store.addCategory(name, parent);
      parent = name;
    }
    const tree = await store.categoryTree();
    expect(tree.get("L7")).toMatchObject({ depth: 6, kind: "expense" });
    expect(tree.path("L7")).toBe("Food & dining › Groceries › L3 › L4 › L5 › L6 › L7");
  });

  it("refuses moves and merges that would make a category its own ancestor", async () => {
    const { store } = await newStore();
    await store.addCategory("Weekly shop", "Groceries");
    await expect(store.moveCategory("Food & dining", "Weekly shop")).rejects.toMatchObject({ code: "category_cycle" });
    await expect(store.moveCategory("Food & dining", "Food & dining")).rejects.toMatchObject({ code: "category_cycle" });
    await expect(store.mergeCategory("Food & dining", "Weekly shop")).rejects.toMatchObject({ code: "category_cycle" });
    expect((await store.categoryTree()).get("Weekly shop")!.parent).toBe("Groceries");
  });

  it("moving a subtree under a root of another kind changes the whole subtree's kind", async () => {
    const { store } = await newStore();
    await store.addCategory("Odd jobs", "Side income");
    await store.addCategory("Coffee beans", "Coffee & tea");
    await store.moveCategory("Coffee & tea", "Income");
    const tree = await store.categoryTree();
    expect(tree.kindOf("Coffee & tea")).toBe("income");
    expect(tree.kindOf("Coffee beans")).toBe("income");
    expect((await store.categoryRows()).find((item) => item.name === "Coffee beans")!.kind).toBe("income");
    await store.moveCategory("Coffee & tea", null);
    expect((await store.categoryTree()).get("Coffee & tea")).toMatchObject({ parent: null, kind: "income" });
  });

  it("entries follow their category's kind on move and merge, like Rails, except locked ones", async () => {
    const { store, db, spend, account } = await book();
    await store.addCategory("Coffee beans", "Coffee & tea");
    const outId = await spend("Coffee beans", -450);
    const lockedId = await spend("Coffee beans", -300);
    const [inId] = await store.ledger.createEntry({ kind: "refund", amountCents: 200, occurredOn: "2026-11-11", accountId: account.id, category: "Coffee beans", description: "ZXQ back" });
    // Typed entries lock their kind; make two of them behave like imported bank rows (nothing locked).
    db.exec(`UPDATE transactions SET user_locked_fields = '[]' WHERE id IN (${outId}, ${inId})`);
    db.exec(`UPDATE transactions SET user_locked_fields = '["kind"]' WHERE id = ${lockedId}`);
    const kindOf = (id: number) => db.exec(`SELECT kind FROM transactions WHERE id = ${id}`)[0].values[0][0];

    await store.moveCategory("Coffee & tea", "Transfers");
    expect([kindOf(outId), kindOf(inId), kindOf(lockedId)]).toEqual(["transfer", "transfer", "expense"]);
    await store.moveCategory("Coffee & tea", "Food & dining");
    expect([kindOf(outId), kindOf(inId), kindOf(lockedId)]).toEqual(["expense", "refund", "expense"]);
    await store.mergeCategory("Coffee beans", "Side income");
    expect([kindOf(outId), kindOf(inId), kindOf(lockedId)]).toEqual(["expense", "income", "expense"]);
  });

  it("renames rewrite entries, rules, budgets, children and schedules in one go", async () => {
    const { store, spend, account } = await book();
    const id = await spend("Groceries", 1200, "ZXQ MARKET 1");
    await store.setCategory(id, "Groceries", true);
    await store.addCategory("Organic", "Groceries");
    await store.ledger.saveBudget({ period: "month", category: "Groceries", amountCents: 50000 });
    await store.ledger.saveRecurringRule({ name: "Box", template: { kind: "expense", amountCents: 3000, accountId: account.id, category: "Groceries" }, frequency: "monthly", startOn: "2026-12-01" });
    expect(await store.renameCategory("groceries", "Supermarket")).toBe("Supermarket");
    expect((await store.transactions()).find((t) => t.id === id)!.category).toBe("Supermarket");
    expect((await store.rules()).map((rule) => rule.category)).toEqual(["Supermarket"]);
    expect((await store.ledger.budgets()).map((budget) => budget.category)).toEqual(["Supermarket"]);
    expect((await store.ledger.recurringRules())[0].template.category).toBe("Supermarket");
    const tree = await store.categoryTree();
    expect(tree.get("Organic")!.parent).toBe("Supermarket");
    expect(tree.get("Supermarket")!.key).toBe("food.groceries");
    await expect(store.renameCategory("Uncategorized", "Later")).rejects.toMatchObject({ code: "not_found" });
  });

  it("deleting moves entries to the parent, rules too, children up in its place, and budgets unless the destination has one", async () => {
    const { store, spend } = await book();
    await store.addCategory("Weekly", "Groceries");
    await store.addCategory("Monthly", "Groceries");
    const id = await spend("Groceries", 800, "ZXQ MARKET 2");
    await store.setCategory(id, "Groceries", true);
    await store.ledger.saveBudget({ period: "month", category: "Groceries", amountCents: 1000 });
    await store.ledger.saveBudget({ period: "year", category: "Groceries", amountCents: 9000 });
    await store.ledger.saveBudget({ period: "year", category: "Food & dining", amountCents: 20000 });
    await store.deleteCategory("Groceries");
    const tree = await store.categoryTree();
    expect(tree.get("Food & dining")!.children.map((child) => child.name)).toEqual(["Weekly", "Monthly", "Restaurants", "Coffee & tea", "Takeout & delivery", "Bars & alcohol"]);
    expect((await store.transactions()).find((t) => t.id === id)!.category).toBe("Food & dining");
    expect((await store.rules()).map((rule) => rule.category)).toEqual(["Food & dining"]);
    expect((await store.ledger.budgets()).map((budget) => `${budget.period}:${budget.category}:${budget.amountCents}`).sort()).toEqual(["month:Food & dining:1000", "year:Food & dining:20000"]);
  });

  it("merging moves entries and rules and gives the children to the destination", async () => {
    const { store, spend } = await book();
    await store.addCategory("Brunch", "Restaurants");
    const id = await spend("Restaurants", 2500, "ZXQ BISTRO");
    await store.setCategory(id, "Restaurants", true);
    expect(await store.mergeCategory("Restaurants", "Takeout & delivery")).toBe(1);
    const tree = await store.categoryTree();
    expect(tree.has("Restaurants")).toBe(false);
    expect(tree.get("Brunch")!.parent).toBe("Takeout & delivery");
    expect((await store.transactions()).find((t) => t.id === id)!.category).toBe("Takeout & delivery");
    expect((await store.rules()).map((rule) => rule.category)).toEqual(["Takeout & delivery"]);
  });

  it("Transfers can be renamed, reordered and given subcategories, but not deleted, merged away or nested", async () => {
    const { store, db } = await newStore();
    await expect(store.deleteCategory("Transfers")).rejects.toMatchObject({ code: "category_protected" });
    await expect(store.mergeCategory("Transfers", "Shopping")).rejects.toMatchObject({ code: "category_protected" });
    await expect(store.moveCategory("Transfers", "Financial")).rejects.toMatchObject({ code: "category_protected" });
    expect(await store.renameCategory("Transfers", "Moving money")).toBe("Moving money");
    await store.addCategory("To savings", "Moving money");
    await store.ledger.moveCategoryStep("Moving money", -1);
    const tree = await store.categoryTree();
    expect(tree.kindOf("To savings")).toBe("transfer");
    expect(tree.roots.at(-2)!.name).toBe("Moving money");
    // Choosing a category of the transfer tree makes an imported entry a transfer.
    await importFile(store, new TextEncoder().encode("Date,Description,Amount\n2026-11-02,ZXQ SOMETHING,-40.00\n"), "t.csv", "USD");
    const [entry] = await store.transactions();
    await store.setCategory(entry.id, "To savings", false);
    expect(db.exec(`SELECT kind FROM transactions WHERE id = ${entry.id}`)[0].values[0][0]).toBe("transfer");
    // The categorizer's transfer rule now files under the renamed category.
    expect((await store.categorizer()).categorize("ONLINE TRANSFER TO SAVINGS", -100)).toBe("Moving money");
  });
});

describe("roll-ups", () => {
  it("a budget, a filter and a report on a category count its whole subtree", async () => {
    const { store, spend } = await book();
    await store.addCategory("Organic", "Groceries");
    await spend("Groceries", 1000);
    await spend("Organic", 500);
    await spend("Food & dining", 300);
    await spend("Shopping", 700);
    await store.ledger.saveBudget({ period: "month", category: "Food & dining", amountCents: 10000 });
    const [budget] = await store.ledger.budgets("2026-11-15");
    expect(budget.status.spentMinor).toBe(1800);

    const tree = await store.categoryTree();
    const all = await store.transactions();
    expect(matchTransactions(all, { category: "Food & dining" }, tree)).toHaveLength(3);
    expect(matchTransactions(all, { category: "Groceries" }, tree)).toHaveLength(2);
    expect(matchTransactions(all, { category: "Groceries" })).toHaveLength(1); // without a tree: that category only

    const byRoot = await store.ledger.report("category");
    expect(byRoot.rows.map((item) => [item.key, item.expenseMinor])).toEqual([["Food & dining", 1800], ["Shopping", 700]]);
    const inside = await store.ledger.report("category", {}, "Food & dining");
    expect(inside.rows.map((item) => [item.key, item.expenseMinor])).toEqual([["Groceries", 1500], ["Food & dining (direct)", 300]]);
    const leaf = await store.ledger.report("category", {}, "Organic");
    expect(leaf.rows.map((item) => [item.key, item.expenseMinor])).toEqual([["Organic", 500]]);
  });
});

describe("keys", () => {
  it("resolve to the current name after a rename, and to the parent key's name after a delete", async () => {
    const { store } = await newStore();
    await store.renameCategory("Food & dining", "Food");
    expect((await store.categorizer()).categorize("WHOLE FOODS MARKET", -1000)).toBe("Food");
    await store.renameCategory("Groceries", "Supermarket");
    expect((await store.categoryTree()).resolveKey("food.groceries")).toBe("Supermarket");
    await store.deleteCategory("Supermarket");
    expect((await store.categoryTree()).resolveKey("food.groceries")).toBe("Food");
    await store.deleteCategory("Food", "Uncategorized");
    expect((await store.categoryTree()).resolveKey("food.groceries")).toBe("Uncategorized");
    expect((await store.categorizer()).categorize("WHOLE FOODS MARKET", -1000)).toBe("Uncategorized");
  });
});

describe("AI proposals", () => {
  it("are never created by applying an answer; approving one creates it and files its rows as one undoable step", async () => {
    const { db } = await newStore();
    const store = recordedStore(new FinanceStore(sqljsDriver(db)));
    await importFile(store, new TextEncoder().encode("Date,Description,Amount\n2026-11-02,ZORBLAX PET SPA,-40.00\n2026-11-03,ZORBLAX PET SPA,-20.00\n2026-11-04,QUUX SHOP,-5.00\n"), "p.csv", "USD");
    const before = (await store.categoryRows()).length;
    const groups = await store.aiCandidates();
    const pet = groups.find((group) => group.text.startsWith("ZORBLAX"))!;
    const tree = await store.categoryTree();
    const proposals = parseAiProposals([{ parent: "Family & pets › Pet food & supplies", name: "Pet grooming", keys: [pet.key] }, { parent: "Nope", name: "X", keys: [pet.key] }], tree, groups.map((group) => group.key));
    expect(proposals).toEqual([{ parent: "Pet food & supplies", name: "Pet grooming", keys: [pet.key] }]);
    await store.applyAiCategoriesBatch(groups, [{ key: "nope", category: "Pet grooming" }]);
    expect(await store.categoryRows()).toHaveLength(before); // never auto-created

    const result = await store.approveAiProposal(groups, proposals[0], "Grooming");
    expect(result).toMatchObject({ name: "Grooming", changed: 2 });
    expect((await store.categoryTree()).get("Grooming")).toMatchObject({ parent: "Pet food & supplies", kind: "expense" });
    expect((await store.transactions()).filter((t) => t.category === "Grooming")).toHaveLength(2);

    const entry = (await store.history.state()).undo!;
    expect(await store.history.step("undo", entry.id)).toBe("done");
    expect((await store.categoryTree()).has("Grooming")).toBe(false);
    expect((await store.transactions()).filter((t) => t.category === "Uncategorized")).toHaveLength(3);
  });

  it("matches answers by full path and never files money out under an income category", async () => {
    const { store } = await newStore();
    await importFile(store, new TextEncoder().encode("Date,Description,Amount\n2026-11-02,ZORBLAX ONE,-40.00\n2026-11-03,QUUX TWO,-20.00\n"), "q.csv", "USD");
    const groups = aiGroups(await store.transactions());
    const [a, b] = groups;
    const { changed } = await store.applyAiCategoriesBatch(groups, [{ key: a.key, category: "Food & dining › Groceries" }, { key: b.key, category: "Salary" }]);
    expect(changed).toBe(1);
    expect((await store.transactions()).map((t) => t.category).sort()).toEqual(["Groceries", "Uncategorized"]);
  });
});

describe("sync", () => {
  it("applies the website's tree additively: creates missing (parents first), adopts parent, kind, order and hidden, deletes nothing, keeps expanded", async () => {
    const { store } = await newStore();
    await store.addCategory("Local only");
    await store.addCategory("Pets");
    await store.ledger.setCategoryExpanded("Pets", true);
    await store.applyWebData({
      currency: "USD", statements: [], transactions: [], rules: [], categories: ["Pets", "Vet visits", "Hobby farm"],
      tree: [
        { name: "Vet visits", parent: "Hobby farm", kind: "expense" }, // listed before its parent: the parent still comes first
        { name: "Hobby farm", parent: null, kind: "expense", sort_order: 40 },
        { name: "Pets", parent: "Family & pets", kind: "expense", sort_order: 9, hidden: true },
        { name: "Bonus", parent: "Income", kind: "income", sort_order: 1 },
      ],
    });
    const rows = await store.categoryRows();
    expect(row(rows, "Hobby farm")).toMatchObject({ parent: null, sortOrder: 40 });
    expect(row(rows, "Vet visits")).toMatchObject({ parent: "Hobby farm" });
    expect(row(rows, "Pets")).toMatchObject({ parent: "Family & pets", sortOrder: 9, hidden: true, expanded: true });
    expect(row(rows, "Local only")).toBeDefined();
    expect(rows).toHaveLength(84 + 4);
  });

  it("older servers without a tree still bring their flat category names", async () => {
    const { store } = await newStore();
    await store.applyWebData({ currency: "USD", statements: [], transactions: [], rules: [], categories: ["Plants"] });
    expect((await store.categoryTree()).get("Plants")).toMatchObject({ parent: null, kind: "expense" });
  });

  it("an uploaded statement carries its rows' categories with every ancestor, parents first", async () => {
    const { store } = await newStore();
    await store.addCategory("Organic", "Groceries");
    await importFile(store, new TextEncoder().encode("Date,Description,Amount\n2026-11-02,ZXQ ONE,-4.00\n2026-11-03,ZXQ TWO,-2.00\n"), "u.csv", "USD");
    const [first, second] = await store.transactions();
    await store.setCategory(first.id, "Organic", false);
    await store.setCategory(second.id, "Shopping", false);
    const statement = (await store.exportData()).statements[0];
    expect(statement.categories).toEqual([
      { name: "Food & dining", parent: null, kind: "expense" }, { name: "Groceries", parent: "Food & dining", kind: "expense" },
      { name: "Organic", parent: "Groceries", kind: "expense" }, { name: "Shopping", parent: null, kind: "expense" },
    ]);
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ id: 1, created: true }), { status: 201 }));
    await uploadStatement("synthetic-token", statement);
    const body = JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body));
    expect(body.statement.categories.map((category: { name: string }) => category.name)).toEqual(["Food & dining", "Groceries", "Organic", "Shopping"]);
    fetchMock.mockRestore();
  });
});

describe("expansion", () => {
  it("is saved with the category and is never part of an undoable edit", async () => {
    const { db } = await newStore();
    const store = recordedStore(new FinanceStore(sqljsDriver(db)));
    await store.addCategory("Pets");
    const undo = (await store.history.state()).undo;
    await store.ledger.setCategoryExpanded("Food & dining", true);
    expect((await store.categoryTree()).get("Food & dining")!.expanded).toBe(true);
    expect((await store.history.state()).undo).toEqual(undo);
    // Undoing the earlier edit is not blocked by the expansion change.
    await store.ledger.setCategoryExpanded("Pets", true);
    expect(await store.history.step("undo", undo!.id)).toBe("done");
    expect((await store.categoryTree()).has("Pets")).toBe(false);
  });

  it("every default is offered once by key", () => {
    expect(new Set(flatDefaultCategories.map((category) => category.key)).size).toBe(84);
  });
});
