// Custom categories and "Categorize with AI" in the local store (no network here).
import initSqlJs from "sql.js";
import { aiGroups, cleanForAi, categoryNameProblem } from "@billie/finance-core";
import { fixtureBytes, migrate, newStore } from "./helpers";
import { importFile } from "../src/services/importFile";
import { sqljsDriver } from "../src/services/sqljsDriver";
import { FinanceStore, StoreError } from "../src/services/store";

async function imported() {
  const { db, store } = await newStore();
  await importFile(store, fixtureBytes("basic-amount.csv"), "b.csv", "USD");
  return { db, store };
}

const byDescription = async (store: FinanceStore, description: string) => (await store.transactions()).find((t) => t.description === description)!;

describe("custom categories", () => {
  it("adds, uses, renames and deletes a category everywhere it is used", async () => {
    const { store } = await imported();
    expect(await store.addCategory("  Cloud   bills ")).toBe("Cloud bills");
    const aws = await byDescription(store, "AMAZON WEB SERVICES AWS.AMAZON.CO");
    await store.setCategory(aws.id, "Cloud bills", true);
    expect((await store.rules()).map((rule) => rule.category)).toEqual(["Cloud bills"]);

    expect(await store.renameCategory("Cloud bills", "Cloud")).toBe("Cloud");
    expect((await byDescription(store, aws.description)).category).toBe("Cloud");
    expect((await store.rules()).map((rule) => rule.category)).toEqual(["Cloud"]);
    expect(await store.customCategories()).toEqual(["Cloud"]);

    expect(await store.deleteCategory("Cloud")).toBe(1);
    expect((await byDescription(store, aws.description)).category).toBe("Uncategorized");
    expect(await store.rules()).toEqual([]);
    expect(await store.customCategories()).toEqual([]);
  });

  it("refuses built-in, duplicate (any letter case), blank and too-long names", async () => {
    const { store } = await newStore();
    await store.addCategory("Pets");
    for (const [name, problem] of [["shopping", "reserved"], ["PETS", "taken"], ["   ", "blank"], ["x".repeat(41), "too_long"]]) {
      await expect(store.addCategory(name)).rejects.toMatchObject({ code: "invalid_category", vars: { problem } });
    }
    await store.addCategory("Gifts");
    await expect(store.renameCategory("Gifts", "pets")).rejects.toBeInstanceOf(StoreError);
    expect(await store.renameCategory("Pets", "pets")).toBe("pets"); // its own name in another case is fine
    expect(categoryNameProblem("Childcare", ["Pets"])).toBeNull();
  });

  it("keeps at most 50 custom categories", async () => {
    const { store } = await newStore();
    for (let i = 1; i <= 50; i += 1) await store.addCategory(`Category ${i}`);
    await expect(store.addCategory("One more")).rejects.toMatchObject({ code: "too_many_categories" });
  });

  it("migration 3 keeps every existing transaction and rule and then allows custom names", async () => {
    const SQL = await initSqlJs();
    const db = new SQL.Database();
    migrate(db, 2);
    // Data as a version-2 app wrote it (today's store code always runs on a fully migrated database).
    db.run("INSERT INTO statements (id, filename, currency, sha256, transaction_count, imported_at) VALUES (1, 'b.csv', 'USD', ?, 2, '2026-01-01T00:00:00Z')", ["a".repeat(64)]);
    db.run("INSERT INTO transactions (statement_id, booked_on, description, amount_cents, category, tax_review, excluded, updated_at, remote_id, locally_modified) VALUES (1, '2026-01-02', 'AMAZON WEB SERVICES AWS.AMAZON.CO', -1299, 'Business', 1, 0, 'x', 77, 1), (1, '2026-01-03', 'Coffee', -500, 'Food & dining', 0, 0, 'x', NULL, 0)");
    db.run("INSERT INTO merchant_rules (merchant_key, income, category, updated_at) VALUES ('amazon web', 0, 'Business', 'x')");
    const before = { transactions: db.exec("SELECT * FROM transactions ORDER BY id")[0].values, rules: db.exec("SELECT * FROM merchant_rules")[0].values };

    migrate(db, 3);
    expect(db.exec("SELECT * FROM transactions ORDER BY id")[0].values).toEqual(before.transactions);
    expect(db.exec("SELECT * FROM merchant_rules")[0].values).toEqual(before.rules);
    migrate(db);
    const store = new FinanceStore(sqljsDriver(db));
    const aws = await byDescription(store, "AMAZON WEB SERVICES AWS.AMAZON.CO");
    await store.addCategory("Cloud");
    await store.setCategory(aws.id, "Cloud", true);
    expect((await byDescription(store, aws.description)).category).toBe("Cloud");
    // Deleting a statement still removes its transactions (the foreign key survived the rebuild).
    db.run("PRAGMA foreign_keys = ON");
    db.run("DELETE FROM statements");
    expect(await store.transactions()).toEqual([]);
  });

  it("copies custom categories along with a sync and with a website download", async () => {
    const { store: source } = await imported();
    await source.addCategory("Cloud");
    await source.addCategory("Unused yet");
    await source.setCategory((await byDescription(source, "AMAZON WEB SERVICES AWS.AMAZON.CO")).id, "Cloud", true);

    const { store: target } = await newStore();
    await target.addCategory("cloud"); // same name, other letter case: reused
    await target.mergeData(await source.exportData());
    expect(await target.customCategories()).toEqual(["cloud", "Unused yet"]);
    expect((await byDescription(target, "AMAZON WEB SERVICES AWS.AMAZON.CO")).category).toBe("cloud");

    const { store: device } = await newStore();
    await device.applyWebData({
      currency: "USD", categories: ["Pets"], rules: [{ merchantKey: "paws place", income: false, category: "Pets" }],
      statements: [{ remoteId: 1, filename: "w.csv", currency: "USD", sha256: "a".repeat(64), transactionCount: 2, closingBalanceCents: null, closingBalanceOn: null, importedAt: "t" }],
      transactions: [
        { remoteId: 10, remoteStatementId: 1, bookedOn: "2026-01-01", description: "PAWS PLACE", amountCents: -900, category: "Pets", taxReview: false, excluded: false },
        { remoteId: 11, remoteStatementId: 1, bookedOn: "2026-01-02", description: "GIFT SHOP", amountCents: -100, category: "Gifts", taxReview: false, excluded: false },
      ],
    });
    expect(await device.customCategories()).toEqual(["Gifts", "Pets"]);
    expect((await device.transactions()).map((t) => t.category).sort()).toEqual(["Gifts", "Pets"]);
  });

  it("deleting all data forgets custom categories", async () => {
    const { store } = await newStore();
    await store.addCategory("Pets");
    await store.deleteAllData();
    expect(await store.customCategories()).toEqual([]);
  });
});

describe("Categorize with AI (local side)", () => {
  it("cleans text like Rails: numbers and email addresses never leave the device", () => {
    expect(cleanForAi("ZORBLAX PET SUPPLY #4421 CARD 4111111111111111")).toBe("ZORBLAX PET SUPPLY CARD");
    expect(cleanForAi("PAY someone@example.com 555-123-4567")).toBe("PAY");
    expect(cleanForAi("12345 #678")).toBeNull();
    expect(cleanForAi("STARBUCKS STORE #1234 SEATTLE WA")).toBe("STARBUCKS STORE SEATTLE WA");
  });

  it("groups Uncategorized transactions by merchant and direction, most frequent first", () => {
    const rows = [
      { id: 1, description: "Zorblax 1", amountCents: -100, category: "Uncategorized" },
      { id: 2, description: "ZORBLAX 2", amountCents: -200, category: "Uncategorized" },
      { id: 3, description: "Zorblax 3", amountCents: 300, category: "Uncategorized" },
      { id: 4, description: "Abc shop", amountCents: -1, category: "Uncategorized" },
      { id: 5, description: "Known", amountCents: -1, category: "Shopping" },
      { id: 6, description: "0000", amountCents: -1, category: "Uncategorized" },
    ];
    expect(aiGroups(rows)).toEqual([
      { key: "1", text: "Zorblax", direction: "out", ids: [1, 2] },
      { key: "2", text: "Abc shop", direction: "out", ids: [4] },
      { key: "3", text: "Zorblax", direction: "in", ids: [3] },
    ]);
  });

  it("applies suggestions only to rows that are still Uncategorized and only with known categories", async () => {
    const { store } = await imported();
    await store.addCategory("Cloud");
    const groups = await store.aiCandidates();
    expect(groups.map((group) => group.text)).toEqual(["AMAZON WEB SERVICES AWS.AMAZON.CO", "HYPERLINK evil"]);
    // Meanwhile the person files the second one themselves: the AI must not overwrite it.
    await store.setCategory((await byDescription(store, "=HYPERLINK(evil)")).id, "Shopping", false);
    const changed = await store.applyAiCategories(groups, [
      { key: "1", category: "Cloud" },
      { key: "2", category: "Health" },
      { key: "9", category: "Health" }, // unknown key
    ]);
    expect(changed).toBe(1);
    expect((await byDescription(store, "AMAZON WEB SERVICES AWS.AMAZON.CO")).category).toBe("Cloud");
    expect((await byDescription(store, "=HYPERLINK(evil)")).category).toBe("Shopping");
    expect(await store.rules()).toEqual([]); // AI guesses are not remembered as rules

    const again = await store.aiCandidates();
    expect(again).toEqual([]);
  });

  it("ignores unknown names, Transfers, and Income for money going out", async () => {
    const { store } = await imported();
    const groups = await store.aiCandidates();
    expect(await store.applyAiCategories(groups, [{ key: "1", category: "Crypto" }, { key: "2", category: "Transfers" }])).toBe(0);
    expect(await store.applyAiCategories(groups, [{ key: "1", category: "Income" }])).toBe(0);
    expect(await store.applyAiCategories(groups, [{ key: "1", category: "Business" }])).toBe(1);
    expect((await byDescription(store, "AMAZON WEB SERVICES AWS.AMAZON.CO")).taxReview).toBe(true); // like Rails
  });
});
