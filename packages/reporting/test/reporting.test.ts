import type { Statement, Transaction } from "@billie/shared-types";
import { buildSnapshot } from "@billie/finance-core";
import { CSV_BOM, excelReport, reportFilename, reportRows, safeText, transactionCsv, unzipStored } from "../src";

const statements: Statement[] = [{ id: 1, filename: "checking.csv", currency: "USD", sha256: "x", transactionCount: 3, closingBalanceCents: null, closingBalanceOn: null, importedAt: "" }];
const transactions: Transaction[] = [
  { id: 1, statementId: 1, bookedOn: "2026-01-02", description: "ACME CORP PAYROLL", amountCents: 250000, category: "Income", taxReview: false, excluded: false },
  { id: 2, statementId: 1, bookedOn: "2026-01-03", description: "=HYPERLINK(\"http://x\")", amountCents: -100, category: "Uncategorized", taxReview: false, excluded: false },
  { id: 3, statementId: 1, bookedOn: "2026-01-04", description: "Quote \"Inc\", Store", amountCents: -1250, category: "Shopping", taxReview: false, excluded: true },
];
const period = { startDate: null, endDate: null };

describe("CSV export (TransactionCsv)", () => {
  it("matches the Rails format: BOM, headers, quoting, formula escaping, amounts", () => {
    const csv = transactionCsv(reportRows(transactions, statements, period));
    expect(csv.startsWith(CSV_BOM)).toBe(true);
    expect(csv.slice(1).split("\n")).toEqual([
      "Date,Account,Merchant,Description,Category,Amount,Currency,Tax review,Excluded,Counted in totals",
      "2026-01-04,checking.csv,Quote Store,\"Quote \"\"Inc\"\", Store\",Shopping,-12.5,USD,false,true,false",
      "2026-01-03,checking.csv,Hyperlink Http,\"'=HYPERLINK(\"\"http://x\"\")\",Uncategorized,-1.0,USD,false,false,true",
      "2026-01-02,checking.csv,Acme Corp,ACME CORP PAYROLL,Income,2500.0,USD,false,false,true",
      "",
    ]);
  });
  it("escapes every formula-start character, including full-width ones", () => {
    for (const start of ["=", "+", "-", "@", "\t", "\r", "＝", "＋", "－", "＠", "  ="]) expect(safeText(`${start}1`)).toBe(`'${start}1`);
    expect(safeText("Plain")).toBe("Plain");
  });
  it("names files like Rails", () => {
    expect(reportFilename({ startDate: "2026-01-01", endDate: "2026-01-31" }, "2026-02-01", "xlsx")).toBe("billieweather-report-2026-01-01-to-2026-01-31-2026-02-01.xlsx");
    expect(reportFilename(period, "2026-02-01", "csv")).toBe("billieweather-report-all-time-2026-02-01.csv");
  });
});

describe("Excel export", () => {
  const snapshot = buildSnapshot({ transactions, statements, period, currency: "USD" });
  const files = unzipStored(excelReport({ snapshot, rows: reportRows(transactions, statements, period), period, currency: "USD", generatedOn: "2026-02-01" }));
  const text = (name: string) => new TextDecoder().decode(files.get(name)!);

  it("is a valid package with three worksheets", () => {
    expect([...files.keys()]).toEqual(expect.arrayContaining(["[Content_Types].xml", "_rels/.rels", "xl/workbook.xml", "xl/styles.xml",
      "xl/worksheets/sheet1.xml", "xl/worksheets/sheet2.xml", "xl/worksheets/sheet3.xml"]));
    expect(text("xl/workbook.xml")).toContain('<sheet name="Transactions"');
    for (const [name, data] of files) if (name.endsWith(".xml") || name.endsWith(".rels")) expect(() => new DOMParserLike(new TextDecoder().decode(data))).not.toThrow();
  });
  it("keeps money numeric and text as plain strings (never formulas)", () => {
    const sheet = text("xl/worksheets/sheet3.xml");
    expect(sheet).toContain("<v>2500</v>");
    expect(sheet).toContain("<v>-12.5</v>");
    expect(sheet).toContain("=HYPERLINK(&quot;http://x&quot;)");
    expect(sheet).not.toContain("<f>");
    expect(text("xl/worksheets/sheet1.xml")).toContain("<v>2500</v>"); // income in Overview
  });
});

// Tiny well-formedness check (balanced tags) so the test does not need a DOM.
class DOMParserLike {
  constructor(xml: string) {
    const stack: string[] = [];
    for (const match of xml.matchAll(/<(\/?)([A-Za-z_][\w:.-]*)[^>]*?(\/?)>/g)) {
      if (match[0].startsWith("<?")) continue;
      const [, closing, name, selfClosing] = match;
      if (selfClosing) continue;
      if (closing) { if (stack.pop() !== name) throw new Error(`Mismatched </${name}>`); } else stack.push(name);
    }
    if (stack.length) throw new Error(`Unclosed <${stack.pop()}>`);
  }
}
