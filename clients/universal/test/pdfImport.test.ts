// PDF statements on the device: text is read with pdf.js, rows are extracted by the
// shared finance-core port, and only clear statements are imported without review.
import { makePdf, newStore } from "./helpers";
import { importFile, importPdfReview } from "../src/services/importFile";
import { pageText, readPdfPages } from "../src/services/pdfText";
import { StoreError } from "../src/services/store";

const CLEAR = makePdf([[
  "Sample Credit Union",
  "Statement period: October 1, 2025 through October 31, 2025",
  [[50, "Date"], [120, "Description"], [420, "Amount"]],
  [[50, "10/02"], [120, "Payroll ACME Corp"], [420, "+2,400.00"]],
  [[50, "10/05"], [120, "Grocery Market"], [420, "-86.35"]],
  [[50, "10/09"], [120, "City Utilities"], [420, "(120.00)"]],
  [[50, "Ending balance"], [420, "2,193.65"]],
]]);

const UNCLEAR = makePdf([[
  "Statement period ending 2025-11-30",
  [[50, "11/03"], [120, "Bookstore"], [420, "24.10"]],
  [[50, "11/04"], [120, "Bakery"], [420, "-3.50"]],
], ["Page two has no transactions."]]);

describe("PDF text", () => {
  it("rebuilds table rows as lines, columns separated by spaces", async () => {
    const pages = await readPdfPages(CLEAR);
    expect(pages).toHaveLength(1);
    const lines = pages[0].split("\n");
    expect(lines[1]).toBe("Statement period: October 1, 2025 through October 31, 2025");
    expect(lines[3]).toMatch(/^10\/02\s+Payroll ACME Corp\s+\+2,400\.00$/);
  });

  it("joins pieces of one word and keeps words apart", () => {
    const item = (str: string, x: number, width: number, y = 100) => ({ str, transform: [10, 0, 0, 10, x, y], width, height: 10 });
    expect(pageText([item("Amaz", 10, 22), item("on", 32, 10), item("-5.00", 200, 25), item("Next", 10, 20, 80)])).toBe("Amazon   -5.00\nNext");
  });

  it("refuses files that are not PDFs or cannot be read", async () => {
    const { store } = await newStore();
    await expect(importFile(store, new TextEncoder().encode("not a pdf"), "s.pdf", "USD")).rejects.toMatchObject({ code: "pdf_not_readable" });
    await expect(importFile(store, new TextEncoder().encode("%PDF-1.4\ngarbage"), "s.pdf", "USD")).rejects.toMatchObject({ code: "pdf_unreadable" });
    await expect(importFile(store, makePdf([["Dear customer, thank you."]]), "s.pdf", "USD")).rejects.toMatchObject({ code: "pdf_no_rows" });
  });
});

describe("PDF import", () => {
  it("imports a clear statement straight away, with its closing balance, and only once", async () => {
    const { store } = await newStore();
    const result = await importFile(store, CLEAR, "october.pdf", "USD");
    expect(result).toMatchObject({ kind: "imported", format: "pdf", count: 3, closingBalanceCents: 219365 });
    const rows = (await store.transactions()).map((row) => [row.bookedOn, row.description, row.amountCents]);
    expect(rows).toEqual(expect.arrayContaining([["2025-10-02", "Payroll ACME Corp", 240000], ["2025-10-09", "City Utilities", -12000]]));
    expect((await store.statements())[0]).toMatchObject({ filename: "october.pdf", closingBalanceOn: "2025-10-31" });
    await expect(importFile(store, CLEAR, "again.pdf", "USD")).rejects.toBeInstanceOf(StoreError);
  });

  it("returns an unclear statement for review and saves nothing until it is confirmed", async () => {
    const { store } = await newStore();
    const review = await importFile(store, UNCLEAR, "november.pdf", "USD");
    if (review.kind !== "review") throw new Error("expected a review");
    expect(review.draft.rows).toEqual([
      { bookedOn: "2025-11-03", description: "Bookstore", amount: "" },
      { bookedOn: "2025-11-04", description: "Bakery", amount: "-3.50" },
    ]);
    expect(review.draft.warnings.map((w) => w.code)).toEqual(expect.arrayContaining(["pdf_amount_unsigned"]));
    expect(await store.transactions()).toEqual([]);

    await expect(importPdfReview(store, review, review.draft.rows.map((row) => ({ ...row, include: true })))).rejects.toMatchObject({ code: "row_invalid_money" });
    const result = await importPdfReview(store, review, [
      { ...review.draft.rows[0], amount: "-24.10", include: true },
      { ...review.draft.rows[1], include: false },
    ]);
    expect(result.count).toBe(1);
    expect((await store.transactions()).map((row) => row.amountCents)).toEqual([-2410]);
  });

  it("checks the device currency first", async () => {
    const { store } = await newStore();
    await importFile(store, CLEAR, "october.pdf", "USD");
    await expect(importFile(store, UNCLEAR, "november.pdf", "EUR")).rejects.toMatchObject({ code: "currency_mismatch" });
  });
});

// Synthetic statements. The text PDF path is account-aware like every other import: the
// account comes from the statement's own text and rows are compared by the shared detector.
describe("PDF import is account-aware", () => {
  const statement = (header: string[], rows: Array<[string, string, string]>) => makePdf([[
    ...header,
    "Statement period: October 1, 2025 through October 31, 2025",
    ...rows.map(([date, description, amount]) => [[50, date], [120, description], [420, amount]] as Array<[number, string]>),
  ]]);
  const CHECKING = ["Chase Total Checking", "Account Number: 000111227890"];
  const sql = <T,>(store: Awaited<ReturnType<typeof newStore>>["store"], query: string) => store.sql.select<T>(query);

  it("stores the detected account with every row and with the statement", async () => {
    const { store } = await newStore();
    const result = await importFile(store, statement(CHECKING, [["10/02", "Payroll ACME Corp", "+2,400.00"], ["10/05", "Grocery Market", "-86.35"]]), "oct.pdf", "USD");
    expect(result.kind).toBe("imported");
    const rows = await sql<{ account_key: string; name: string; account_type: string }>(store,
      "SELECT t.account_key, a.name, a.account_type FROM transactions t JOIN accounts a ON a.id = t.account_id");
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.account_key === "chase|7890|checking" && row.account_type === "checking")).toBe(true);
    const [stored] = await sql<{ account_key: string; account_last4: string; source_format: string }>(store, "SELECT account_key, account_last4, source_format FROM statements");
    expect(stored).toEqual({ account_key: "chase|7890|checking", account_last4: "7890", source_format: "pdf_text" });
    expect(JSON.stringify(await sql(store, "SELECT * FROM statements"))).not.toContain("000111227890");
  });

  it("an overlapping statement of the same account is reviewed, never imported twice or dropped silently", async () => {
    const { store } = await newStore();
    await importFile(store, statement(CHECKING, [["10/02", "Payroll ACME Corp", "+2,400.00"], ["10/05", "Grocery Market", "-86.35"]]), "first.pdf", "USD");
    // A different file (another export of the same month) with the same two rows plus a new one.
    const review = await importFile(store, statement(CHECKING, [["10/02", "Payroll ACME Corp", "+2,400.00"], ["10/05", "Grocery Market", "-86.35"], ["10/19", "City Utilities", "-120.00"]]), "second.pdf", "USD");
    if (review.kind !== "review") throw new Error("an overlapping statement must be reviewed");
    expect(review.draft.rows.map((row) => row.duplicate)).toEqual(["duplicate", "duplicate", undefined]);
    expect(await store.transactions()).toHaveLength(2);
    // The review's suggestion: leave the rows that are already stored out.
    await importPdfReview(store, review, review.draft.rows.map((row) => ({ ...row, include: row.duplicate !== "duplicate" })));
    const amounts = (await store.transactions()).map((row) => row.amountCents).sort((a, b) => a - b);
    expect(amounts).toEqual([-12000, -8635, 240000]);
  });

  it("identical rows on a different known account are separate transactions, without review", async () => {
    const { store } = await newStore();
    await importFile(store, statement(CHECKING, [["10/05", "Streaming Service", "-15.99"]]), "checking.pdf", "USD");
    const other = await importFile(store, statement(["Chase Total Checking", "Account Number: 000111224321"], [["10/05", "Streaming Service", "-15.99"]]), "other.pdf", "USD");
    expect(other.kind).toBe("imported");
    const keys = await sql<{ account_key: string }>(store, "SELECT account_key FROM transactions ORDER BY account_key");
    expect(keys.map((row) => row.account_key)).toEqual(["chase|4321|checking", "chase|7890|checking"]);
  });

  it("a statement that names no account is only a possible duplicate of rows with a known account", async () => {
    const { store } = await newStore();
    await importFile(store, statement(CHECKING, [["10/05", "Grocery Market", "-86.35"]]), "known.pdf", "USD");
    const review = await importFile(store, statement(["Sample Credit Union"], [["10/05", "Grocery Market", "-86.35"]]), "unknown.pdf", "USD");
    if (review.kind !== "review") throw new Error("a possible duplicate must be reviewed");
    expect(review.draft.account?.key).toBeNull();
    expect(review.draft.rows[0].duplicate).toBe("review");
  });

  it("money in on a credit card statement is a refund or a repayment, never income", async () => {
    const { store } = await newStore();
    const card = statement(["Capital One", "Credit card statement", "Account ending in 9876"],
      [["10/03", "Outfitters", "-80.00"], ["10/15", "Outfitters Return", "+30.00"], ["10/28", "Payment Thank You", "+170.00"]]);
    expect((await importFile(store, card, "card.pdf", "USD")).kind).toBe("imported");
    const kinds = Object.fromEntries((await store.transactions()).map((row) => [row.amountCents, row.kind]));
    expect(kinds).toEqual({ [-8000]: "expense", 3000: "refund", 17000: "card_payment" });
    const { income, expenses } = await sql<{ income: number; expenses: number }>(store,
      "SELECT COALESCE(SUM(CASE WHEN kind = 'income' THEN amount_cents END), 0) AS income, -SUM(CASE WHEN kind IN ('expense','refund') THEN amount_cents ELSE 0 END) AS expenses FROM transactions").then((r) => r[0]);
    expect([income, expenses]).toEqual([0, 5000]);
  });
});
