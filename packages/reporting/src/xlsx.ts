// Excel workbook in the shape of app/services/finance/excel_report.rb: Overview,
// Categories, Transactions. Money stays numeric with a currency format; all text is
// written as inline strings, so a description like "=HYPERLINK(...)" is never a formula.
import { centsToNumber } from "@billie/finance-core";
import type { Currency, Period, Snapshot } from "@billie/shared-types";
import type { ReportRow } from "./rows";
import { zipStored } from "./zip";

type Cell = { t: "s"; v: string; style?: Style } | { t: "n"; v: number; style?: Style } | null;
type Style = "header" | "money" | "percent" | "bold" | "title";
const STYLE_IDS: Record<Style, number> = { title: 1, header: 2, money: 3, percent: 4, bold: 5 };

const UNITS: Record<string, string> = { USD: "$", CAD: "CA$", EUR: "€", GBP: "£", AUD: "A$", CNY: "¥" };

const xml = (text: string) =>
  text.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!)
    // Characters XML 1.0 forbids would corrupt the workbook.
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, "");

const columnName = (index: number) => {
  let name = "";
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) name = String.fromCharCode(65 + ((n - 1) % 26)) + name;
  return name;
};

function sheetXml(rows: Cell[][], widths: number[]): string {
  const cols = widths.map((width, i) => `<col min="${i + 1}" max="${i + 1}" width="${width}" customWidth="1"/>`).join("");
  const body = rows.map((cells, r) => {
    const content = cells.map((cell, c) => {
      if (!cell) return "";
      const ref = `${columnName(c)}${r + 1}`;
      const style = cell.style ? ` s="${STYLE_IDS[cell.style]}"` : "";
      return cell.t === "n"
        ? `<c r="${ref}"${style}><v>${cell.v}</v></c>`
        : `<c r="${ref}" t="inlineStr"${style}><is><t xml:space="preserve">${xml(cell.v)}</t></is></c>`;
    }).join("");
    return `<row r="${r + 1}">${content}</row>`;
  }).join("");
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><cols>${cols}</cols><sheetData>${body}</sheetData></worksheet>`;
}

const s = (v: string | null | undefined, style?: Style): Cell => ({ t: "s", v: v ?? "", style });
const money = (cents: number, style: Style = "money"): Cell => ({ t: "n", v: centsToNumber(cents), style });

export interface WorkbookInput {
  snapshot: Snapshot;
  rows: readonly ReportRow[];
  period: Pick<Period, "startDate" | "endDate">;
  currency: Currency;
  generatedOn: string;
}

export function excelReport(input: WorkbookInput): Uint8Array {
  const { snapshot } = input;
  const range = input.period.startDate && input.period.endDate ? `${input.period.startDate} – ${input.period.endDate}` : "All time";
  const overview: Cell[][] = [
    [s("BillieWeather report", "title")],
    [s(`${range} · ${input.currency} · generated ${input.generatedOn}`)],
    [],
    [s("Income", "bold"), money(snapshot.incomeCents)],
    [s("Expenses", "bold"), money(snapshot.expensesCents)],
    [s("Net cash flow", "bold"), money(snapshot.netCents)],
    [s("Latest statement balance", "bold"), snapshot.balanceCents === null ? s("—") : money(snapshot.balanceCents), s(snapshot.balanceOn ?? "")],
    [],
    [s("Transactions", "bold"), { t: "n", v: snapshot.transactionCount }],
    [s("Uncategorized", "bold"), { t: "n", v: snapshot.uncategorizedCount }],
    [s("Transfers (not counted)", "bold"), { t: "n", v: snapshot.transferCount }],
    [s("Excluded (not counted)", "bold"), { t: "n", v: snapshot.excludedCount }],
    [],
    [s("Month", "header"), s("Income", "header"), s("Expenses", "header"), s("Net", "header")],
    ...snapshot.monthly.map((month) => [s(month.month.slice(0, 7)), money(month.incomeCents), money(month.expensesCents), money(month.netCents)]),
    [],
    [s("BillieWeather provides financial organization and estimates only. It is not individualized financial, legal, or tax advice.")],
  ];
  const categories: Cell[][] = [
    [s("Category", "header"), s("Spending", "header"), s("Share of spending", "header")],
    ...snapshot.categories.map((category) => [s(category.name), money(category.amountCents),
      category.share === null ? null : ({ t: "n", v: category.share, style: "percent" } as Cell)]),
    [s("Total", "bold"), money(snapshot.expensesCents)],
  ];
  const transactions: Cell[][] = [
    ["Date", "Account", "Merchant", "Description", "Category", "Amount", "Currency", "Tax review", "Excluded", "Counted in totals"].map((h) => s(h, "header")),
    ...input.rows.map((row) => [s(row.bookedOn), s(row.account), s(row.merchant), s(row.description), s(row.category), money(row.amountCents),
      s(row.currency), s(row.taxReview ? "Yes" : "No"), s(row.excluded ? "Yes" : "No"), s(row.counted ? "Yes" : "No")]),
  ];

  const unit = (UNITS[input.currency] ?? `${input.currency} `).replace(/"/g, "");
  const format = xml(`"${unit}"#,##0.00;[Red]-"${unit}"#,##0.00`);
  const styles = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
    `<numFmts count="1"><numFmt numFmtId="164" formatCode="${format}"/></numFmts>` +
    `<fonts count="4"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="16"/><color rgb="FF2F4F3A"/><name val="Calibri"/></font>` +
    `<font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>` +
    `<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill>` +
    `<fill><patternFill patternType="solid"><fgColor rgb="FF356B4F"/></patternFill></fill></fills>` +
    `<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>` +
    `<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>` +
    `<cellXfs count="6"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>` +
    `<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>` +
    `<xf numFmtId="0" fontId="2" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/>` +
    `<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>` +
    `<xf numFmtId="10" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>` +
    `<xf numFmtId="0" fontId="3" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs></styleSheet>`;

  const sheets = [
    { name: "Overview", xml: sheetXml(overview, [28, 18, 18, 18]) },
    { name: "Categories", xml: sheetXml(categories, [24, 16, 18]) },
    { name: "Transactions", xml: sheetXml(transactions, [12, 24, 22, 44, 16, 14, 10, 11, 10, 16]) },
  ];
  const enc = new TextEncoder();
  const files = [
    { name: "[Content_Types].xml", data: enc.encode(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("")}</Types>`) },
    { name: "_rels/.rels", data: enc.encode(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`) },
    { name: "xl/workbook.xml", data: enc.encode(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheets.map((sheet, i) => `<sheet name="${sheet.name}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("")}</sheets></workbook>`) },
    { name: "xl/_rels/workbook.xml.rels", data: enc.encode(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join("")}<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`) },
    { name: "xl/styles.xml", data: enc.encode(styles) },
    ...sheets.map((sheet, i) => ({ name: `xl/worksheets/sheet${i + 1}.xml`, data: enc.encode(sheet.xml) })),
  ];
  return zipStored(files);
}
