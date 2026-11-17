import { API_ORIGIN } from "../src/services/account";
import { uploadStatement } from "../src/services/cloudUpload";
import { runTransfer } from "../src/services/transfer";
import { syncFromWeb } from "../src/services/webSync";
import { newStore } from "./helpers";

const bankRow = {
  id: 70, statement_id: 7, booked_on: "2026-10-15", description: "Edited store label",
  original_description: "ZXQ OUTFITTERS 0042", amount: "30.00", category: "Uncategorized",
  kind: "refund", tax_review: false, excluded: false,
};

function cloud() {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const path = String(input).replace(`${API_ORIGIN}/api/client/v1/finance`, "");
    let body: unknown;
    if (path === "") body = { currency: "USD", version: "v1", statement_count: 1, transaction_count: 1 };
    else if (path === "/statements") body = { statements: [{ id: 7, filename: "card.csv", currency: "USD", sha256: "f".repeat(64), transaction_count: 1, closing_balance: null, closing_balance_on: null, imported_at: "2026-11-01T00:00:00Z" }] };
    else if (path.startsWith("/transactions")) body = { transactions: [bankRow], next_after_id: null };
    else if (path === "/rules") body = { rules: [] };
    else body = { categories: [] };
    return new Response(JSON.stringify(body), { status: 200 });
  });
}

afterEach(() => vi.restoreAllMocks());

it("downloads explicit financial kind and the immutable bank description through the real network adapter", async () => {
  cloud();
  const { store } = await newStore();
  await syncFromWeb(store, "synthetic-token");
  expect(await store.transactions()).toMatchObject([{ kind: "refund", description: "Edited store label", originalDescription: "ZXQ OUTFITTERS 0042" }]);
});

it("preserves financial meaning and bank evidence when copying cloud and local statements", async () => {
  cloud();
  const source = (await newStore()).store;
  const target = (await newStore()).store;
  const context = { getToken: () => "synthetic-token", openStore: async (id: string) => id === "1" ? source : target };
  await runTransfer({ kind: "cloud" }, { kind: "local", id: "1" }, false, context);
  await runTransfer({ kind: "local", id: "1" }, { kind: "local", id: "2" }, false, context);
  expect(await target.transactions()).toMatchObject([{ kind: "refund", originalDescription: "ZXQ OUTFITTERS 0042" }]);
  expect((await target.exportData()).statements[0].rows[0]).toMatchObject({ kind: "refund", originalDescription: "ZXQ OUTFITTERS 0042" });
});

it("includes explicit kind and original description in an authorized cloud upload", async () => {
  cloud();
  const store = (await newStore()).store;
  await syncFromWeb(store, "synthetic-token");
  const send = vi.spyOn(globalThis, "fetch").mockClear().mockResolvedValue(new Response(JSON.stringify({ id: 8, created: true }), { status: 201 }));
  await uploadStatement("synthetic-token", (await store.exportData()).statements[0]);
  const payload = JSON.parse(String(send.mock.calls[0][1]?.body));
  expect(payload.statement.transactions[0]).toMatchObject({ kind: "refund", original_description: "ZXQ OUTFITTERS 0042" });
});

it("rejects an incomplete download before deleting or updating any existing copies", async () => {
  const server = cloud();
  const store = (await newStore()).store;
  await syncFromWeb(store, "synthetic-token");
  const original = server.getMockImplementation()!;
  server.mockImplementation(async (input, init) => String(input).includes("/transactions?")
    ? new Response(JSON.stringify({ transactions: [bankRow], next_after_id: 70 }), { status: 200 })
    : original(input, init));
  await expect(syncFromWeb(store, "synthetic-token", { force: true })).rejects.toThrow();
  expect(await store.transactions()).toHaveLength(1);
  expect((await store.webSyncSettings()).version).toBe("v1");
});

// Synthetic data. Account identity travels with a statement (bank, last four digits, kind).
describe("account identity in transfers", () => {
  const cardCsv = "Bank: Synthetic Bank\nCard number: ****9876\nCredit card statement\nDate,Description,Amount\n2026-10-03,ZXQ OUTFITTERS,-80.00\n2026-10-15,ZXQ OUTFITTERS RETURN,30.00\n";

  async function sourceWithCard() {
    const { importDraftFile, commitDraft, importContext } = await import("../src/services/universalImport");
    const { reviseDraft } = await import("@billie/finance-core");
    const source = await newStore();
    let draft = await importDraftFile(source.store, new TextEncoder().encode(cardCsv), "card.csv", "USD");
    const context = await importContext(source.store);
    // Whatever the preview still asks about is answered the way a person would: keep every row.
    draft = reviseDraft(draft, { conventions: { amountSign: "as_is" }, decisions: Object.fromEntries(draft.rows.map((row) => [row.id, "include" as const])) }, context);
    await commitDraft(source.store, draft, context);
    return source;
  }

  it("a copy to another local database keeps the account, so a later import of that account is compared exactly", async () => {
    const source = await sourceWithCard();
    const exported = await source.store.exportData();
    expect(exported.statements[0].account).toEqual({ institution: "Synthetic Bank", last4: "9876", kind: "credit_card" });
    expect(JSON.stringify(exported)).not.toContain("****");

    const target = await newStore();
    await target.store.mergeData(exported);
    const rows = target.db.exec("SELECT t.account_key, a.account_type, t.kind FROM transactions t JOIN accounts a ON a.id = t.account_id ORDER BY t.id")[0].values;
    expect(rows).toEqual([["synthetic bank|9876|credit_card", "credit_card", "expense"], ["synthetic bank|9876|credit_card", "credit_card", "refund"]]);
    expect(target.db.exec("SELECT account_key, account_last4 FROM statements")[0].values).toEqual([["synthetic bank|9876|credit_card", "9876"]]);
    // The copied rows are found by the account-scoped duplicate index of the target.
    expect((await target.store.dedupeIndex()).every((row) => row.accountKey === "synthetic bank|9876|credit_card")).toBe(true);
  });

  it("a merge is one transaction: a failure in a later statement leaves nothing of the earlier ones", async () => {
    const source = await sourceWithCard();
    const exported = await source.store.exportData();
    const broken = { ...exported, statements: [exported.statements[0], { ...exported.statements[0], sha256: "e".repeat(64), rows: [{ ...exported.statements[0].rows[0], bookedOn: null as unknown as string }] }] };
    const target = await newStore();
    await expect(target.store.mergeData(broken)).rejects.toThrow();
    expect(target.db.exec("SELECT COUNT(*) FROM statements")[0].values[0][0]).toBe(0);
    expect(target.db.exec("SELECT COUNT(*) FROM transactions")[0].values[0][0]).toBe(0);
    expect(await target.store.currency()).toBeNull();
  });

  it("an upload names the account, never a full number", async () => {
    const source = await sourceWithCard();
    const [statement] = (await source.store.exportData()).statements;
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ id: 1, created: true }), { status: 201 }));
    await uploadStatement("synthetic-token", statement);
    const body = JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body));
    expect(body.statement.account).toEqual({ institution: "Synthetic Bank", last4: "9876", kind: "credit_card" });
    fetchMock.mockRestore();
  });
});
