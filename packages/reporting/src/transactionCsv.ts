// Port of app/services/finance/transaction_csv.rb — byte-for-byte the same output.
import { centsToDecimalString, csvField } from "@billie/finance-core";
import type { ReportRow } from "./rows";

export const CSV_BOM = "﻿";
export const CSV_HEADERS = ["Date", "Account", "Merchant", "Description", "Category", "Amount", "Currency", "Tax review", "Excluded", "Counted in totals"];
// =, +, -, @, tab and carriage return (and full-width forms) start a formula in spreadsheet apps.
const FORMULA_START = /^[\s　]*[=+\-@\t\r＝＋－＠]/;

export function safeText(value: string | null | undefined): string {
  const text = value ?? "";
  return FORMULA_START.test(text) ? `'${text}` : text;
}

export function transactionCsv(rows: readonly ReportRow[]): string {
  const lines = [CSV_HEADERS.map(csvField).join(",")];
  for (const row of rows) {
    lines.push([
      row.bookedOn, safeText(row.account), safeText(row.merchant), safeText(row.description), safeText(row.category),
      centsToDecimalString(row.amountCents), row.currency, String(row.taxReview), String(row.excluded), String(row.counted),
    ].map(csvField).join(","));
  }
  return CSV_BOM + lines.join("\n") + "\n";
}
