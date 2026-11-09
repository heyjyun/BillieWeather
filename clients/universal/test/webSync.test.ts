import type { WebData } from "../src/services/store";
import { syncFromWeb } from "../src/services/webSync";
import { API_ORIGIN } from "../src/services/account";
import { fixtureBytes, migrate, newStore } from "./helpers";
import { importFile } from "../src/services/importFile";
import initSqlJs from "sql.js";
import { sqljsDriver } from "../src/services/sqljsDriver";
import { FinanceStore } from "../src/services/store";

const web = (overrides: Partial<WebData> = {}): WebData => ({
  currency: "USD",
  statements: [{ remoteId: 501, filename: "web-checking.csv", currency: "USD", sha256: "f".repeat(64), transactionCount: 3, closingBalanceCents: 120000, closingBalanceOn: "2026-03-31", importedAt: "2026-04-01T00:00:00Z" }],
  transactions: [
    { remoteId: 9001, remoteStatementId: 501, bookedOn: "2026-03-01", description: "WEB PAYROLL", amountCents: 100000, category: "Income", taxReview: false, excluded: false },
    { remoteId: 9002, remoteStatementId: 501, bookedOn: "2026-03-02", description: "WEB COFFEE BAR", amountCents: -450, category: "Food & dining", taxReview: false, excluded: false },
    { remoteId: 9003, remoteStatementId: 501, bookedOn: "2026-03-03", description: "WEB MYSTERY", amountCents: -999, category: "Uncategorized", taxReview: false, excluded: false },
  ],
  rules: [{ merchantKey: "zed bakers", income: false, category: "Business" }],
  ...overrides,
});

describe("merging website data into the local database", () => {
  it("adds website statements, transactions, rules and the currency; a repeat download changes nothing", async () => {
    const { store } = await newStore();
    expect(await store.applyWebData(web())).toEqual({ statementsAdded: 1, statementsRemoved: 0, transactionsAdded: 3, transactionsUpdated: 0, transactionsRemoved: 0, skippedDuplicates: 0 });
    const [statement] = await store.statements();
    expect(statement).toMatchObject({ filename: "web-checking.csv", source: "web", closingBalanceCents: 120000 });
    expect((await store.transactions()).length).toBe(3);
    expect(await store.rules()).toEqual([{ merchantKey: "zed bakers", income: false, category: "Business" }]);
    expect(await store.currency()).toBe("USD");
    expect(await store.applyWebData(web())).toEqual({ statementsAdded: 0, statementsRemoved: 0, transactionsAdded: 0, transactionsUpdated: 0, transactionsRemoved: 0, skippedDuplicates: 0 });
  });

  it("applies website edits and deletions, but keeps categories changed on this device", async () => {
    const { store } = await newStore();
    await store.applyWebData(web());
    const mystery = (await store.transactions()).find((t) => t.description === "WEB MYSTERY")!;
    await store.setCategory(mystery.id, "Shopping", false);

    const edited = web();
    edited.transactions[1] = { ...edited.transactions[1], category: "Business", description: "WEB COFFEE BAR #2" };
    edited.transactions[2] = { ...edited.transactions[2], category: "Health", amountCents: -1099 };
    edited.transactions.splice(0, 1); // deleted on the website
    expect(await store.applyWebData(edited)).toMatchObject({ transactionsUpdated: 2, transactionsRemoved: 1 });

    const byRemote = Object.fromEntries((await store.transactions()).map((t) => [t.description, t]));
    expect(byRemote["WEB COFFEE BAR #2"].category).toBe("Business");
    expect(byRemote["WEB MYSTERY"].category).toBe("Shopping"); // local choice kept
    expect(byRemote["WEB MYSTERY"].amountCents).toBe(-1099); // amount follows the website
    expect(byRemote["WEB PAYROLL"]).toBeUndefined();

    expect(await store.applyWebData(web({ statements: [], transactions: [] }))).toMatchObject({ statementsRemoved: 1 });
    expect(await store.transactions()).toEqual([]);
  });

  it("never duplicates a statement already imported on this device, and never touches local imports", async () => {
    const { store } = await newStore();
    const bytes = fixtureBytes("basic-amount.csv");
    await importFile(store, bytes, "basic-amount.csv", "USD");
    const sha = (await store.statements())[0].sha256;
    const result = await store.applyWebData(web({ statements: [{ ...web().statements[0], sha256: sha }] }));
    expect(result).toMatchObject({ skippedDuplicates: 1, statementsAdded: 0, transactionsAdded: 0 });
    expect((await store.transactions()).length).toBe(9);
    await store.applyWebData(web({ statements: [], transactions: [] }));
    expect((await store.transactions()).length).toBe(9);
  });

  it("refuses website data in another currency, and this device's rules win", async () => {
    const { store } = await newStore();
    await importFile(store, new TextEncoder().encode("Date,Description,Amount\n2026-01-01,ZED BAKERS 1,-5.00\n"), "z.csv", "USD");
    const first = (await store.transactions())[0];
    await store.setCategory(first.id, "Food & dining", true);
    await expect(store.applyWebData(web({ currency: "EUR", statements: [{ ...web().statements[0], currency: "EUR" }] }))).rejects.toMatchObject({ code: "currency_mismatch" });
    await store.applyWebData(web());
    expect(await store.rules()).toEqual([{ merchantKey: "zed bakers", income: false, category: "Food & dining" }]);
  });

  it("migrating a version-1 database to version 2 keeps every row", async () => {
    const SQL = await initSqlJs();
    const db = new SQL.Database();
    migrate(db, 1);
    const v1 = new FinanceStore(sqljsDriver(db));
    // Write with the version-1 columns only.
    db.run("INSERT INTO statements (filename, currency, sha256, transaction_count, imported_at) VALUES ('old.csv','USD','abc',1,'2026-01-01')");
    db.run("INSERT INTO transactions (statement_id, booked_on, description, amount_cents, category, updated_at) VALUES (1,'2026-01-02','Old coffee',-300,'Food & dining','t')");
    db.run("INSERT INTO merchant_rules (merchant_key, income, category, updated_at) VALUES ('old coffee',0,'Food & dining','t')");
    migrate(db);
    expect(await v1.statements()).toMatchObject([{ filename: "old.csv", source: "local" }]);
    expect(await v1.transactions()).toMatchObject([{ description: "Old coffee", amountCents: -300 }]);
    expect((await v1.rules()).length).toBe(1);
  });
});

describe("syncFromWeb (network)", () => {
  function fakeServer(version: string) {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      calls.push({ url, init: init ?? {} });
      const path = url.replace(`${API_ORIGIN}/api/client/v1/finance`, "");
      if (path === "") return json({ currency: "USD", version, statement_count: 1, transaction_count: 1 });
      if (path === "/statements") return json({ statements: [{ id: 7, filename: "w.csv", currency: "USD", sha256: "e".repeat(64), transaction_count: 1, closing_balance: "10.50", closing_balance_on: "2026-01-31", imported_at: "2026-02-01T00:00:00Z" }] });
      if (path === "/rules") return json({ rules: [] });
      if (path.startsWith("/transactions")) return json({ transactions: [{ id: 70, statement_id: 7, booked_on: "2026-01-05", description: "WEB SHOP", amount: "-12.5", category: "Shopping", tax_review: false, excluded: false }], next_after_id: null });
      return new Response("{}", { status: 404 });
    });
    return calls;
  }
  afterEach(() => vi.restoreAllMocks());

  it("downloads only when the website version changed, using GET requests with no body", async () => {
    const { store } = await newStore();
    const calls = fakeServer("v1");
    expect(await syncFromWeb(store, "tok")).toMatchObject({ status: "updated", result: { statementsAdded: 1, transactionsAdded: 1 } });
    expect((await store.transactions())[0]).toMatchObject({ description: "WEB SHOP", amountCents: -1250 });
    const downloaded = calls.length;
    expect(await syncFromWeb(store, "tok")).toEqual({ status: "upToDate" });
    expect(calls.length).toBe(downloaded + 1); // only the version check
    for (const { url, init } of calls) {
      expect(init.method).toBe("GET");
      expect(init.body).toBeUndefined();
      expect(url.startsWith(`${API_ORIGIN}/api/client/v1/finance`)).toBe(true);
      expect((init.headers as Record<string, string>).Authorization).toBe("Bearer tok");
    }
    expect((await store.webSyncSettings()).version).toBe("v1");
  });

  it("does nothing at all when website download is turned off", async () => {
    const { store } = await newStore();
    const calls = fakeServer("v1");
    await store.setWebSyncEnabled(false);
    expect(await syncFromWeb(store, "tok")).toEqual({ status: "disabled" });
    expect(calls).toEqual([]);
    await store.deleteAllData();
    expect((await store.webSyncSettings()).enabled).toBe(false); // the preference survives deleting data
  });
});
