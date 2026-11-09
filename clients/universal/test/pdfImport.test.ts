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
