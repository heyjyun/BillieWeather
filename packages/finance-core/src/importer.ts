// Port of the parsing half of app/services/finance/statement_importer.rb: header
// detection, money/date parsing, debit/credit and type columns, categorization and
// closing-balance detection. Storage (dedupe by SHA-256, inserting rows) is the
// client's job. Error codes match the Rails I18n keys under billie.backend.*.
import { CATEGORIES, CURRENCIES, type Category, type Currency, type IsoDate, type ParsedStatement, type ParsedTransaction } from "@billie/shared-types";
import { Categorizer } from "./categorizer";
import { MalformedCsvError, parseCsv } from "./csv";
import { decimalToCents, MONEY_LIMIT_CENTS } from "./money";

export const MAX_BYTES = 2 * 1024 * 1024;
export const MAX_ROWS = 5_000;

export type ImportErrorCode =
  | "require_csv" | "filename_too_long" | "statement_empty" | "statement_size_limit" | "csv_encoding" | "csv_binary" | "unsupported_currency"
  | "csv_unreadable" | "csv_require_rows" | "csv_duplicate_headers" | "one_column_only" | "csv_required_columns" | "csv_amount_columns"
  | "statement_row_limit" | "csv_extra_values" | "statement_no_transactions" | "row_description_required" | "row_description_length"
  | "row_currency_mismatch" | "row_invalid_type" | "row_debit_credit" | "row_invalid_date" | "row_currency_symbol" | "row_invalid_money"
  | "row_money_limit";

const MESSAGES: Record<ImportErrorCode, string> = {
  require_csv: "Choose a .csv file.",
  filename_too_long: "The file name is too long.",
  statement_empty: "The file is empty.",
  statement_size_limit: "The file is larger than 2 MB.",
  csv_encoding: "The CSV must be UTF-8 text.",
  csv_binary: "The file does not look like a CSV.",
  unsupported_currency: "That currency is not supported.",
  csv_unreadable: "The CSV could not be read. Check for unclosed quotes.",
  csv_require_rows: "The CSV needs a header row and at least one transaction.",
  csv_duplicate_headers: "The CSV has two columns with the same name.",
  one_column_only: "The CSV has more than one column for the same field.",
  csv_required_columns: "The CSV needs date, description, and amount (or debit and credit) columns.",
  csv_amount_columns: "Use either an amount column or debit/credit columns, not both.",
  statement_row_limit: "The file has more than 5,000 transactions.",
  csv_extra_values: "A row has more values than there are columns.",
  statement_no_transactions: "No transactions were found.",
  row_description_required: "A row is missing its description.",
  row_description_length: "A description is longer than 500 characters.",
  row_currency_mismatch: "A row uses a different currency.",
  row_invalid_type: "A row has an unknown transaction type.",
  row_debit_credit: "A row has both a debit and a credit, or a negative one.",
  row_invalid_date: "A row has a date that is not YYYY-MM-DD or MM/DD/YYYY.",
  row_currency_symbol: "A row's currency symbol does not match the statement currency.",
  row_invalid_money: "A row has an amount that is not a number.",
  row_money_limit: "A row's amount is too large.",
};

export class ImportError extends Error {
  /** Values for the translated message (Rails: billie.backend.<code>). */
  public vars: Record<string, string | number>;

  constructor(public code: ImportErrorCode, public row?: number, vars: Record<string, string | number> = {}) {
    super(row ? `Row ${row}: ${MESSAGES[code]}` : MESSAGES[code]);
    this.name = "ImportError";
    this.vars = row ? { row, ...vars } : vars;
  }
}

const DATE_COLUMN_PRIORITY = ["transaction date", "date", "post date", "posting date", "posted date", "booked on", "booking date"];
const BALANCE_HEADERS = ["closing balance", "ending balance", "running balance", "balance after", "balance after transaction", "post transaction balance",
  "ledger balance", "current balance", "account balance", "available balance", "balance"];
const HEADER_ALIASES = {
  description: ["description", "transaction description", "details", "memo", "merchant", "payee", "name"],
  amount: ["amount", "transaction amount", "net amount"],
  debit: ["debit", "debit amount", "withdrawal", "withdrawals", "money out"],
  credit: ["credit", "credit amount", "deposit", "deposits", "money in"],
  category: ["category"],
  currency: ["currency", "currency code"],
  type: ["type", "transaction type", "debit credit", "credit debit"],
} as const;
type Column = keyof typeof HEADER_ALIASES | "date" | "balance";

const SYMBOL_CURRENCIES: Record<string, string[]> = { $: ["USD", "CAD", "AUD", "NZD", "SGD", "HKD"], "£": ["GBP"], "€": ["EUR"], "¥": ["JPY", "CNY"] };

export function normalizeHeader(value: string | undefined): string {
  return (value ?? "").trim().toLowerCase().replace(/[_\-/]+/g, " ").replace(/\s+/g, " ");
}

export interface ImportOptions {
  filename: string;
  currency: Currency;
  categorizer: Categorizer;
}

/** Validates the raw file bytes and returns UTF-8 text without a BOM. */
export function decodeStatementBytes(bytes: Uint8Array, filename: string): string {
  const base = filename.replace(/\\/g, "/").split("/").pop() ?? "";
  if (!base.toLowerCase().endsWith(".csv")) throw new ImportError("require_csv");
  if ([...base].length > 255) throw new ImportError("filename_too_long");
  if (bytes.length === 0) throw new ImportError("statement_empty");
  if (bytes.length > MAX_BYTES) throw new ImportError("statement_size_limit");
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new ImportError("csv_encoding");
  }
  if (text.trim() === "") throw new ImportError("statement_empty");
  if (text.includes("\0")) throw new ImportError("csv_binary");
  return text.replace(/^﻿/, "");
}

/** SHA-256 of the file bytes, lowercase hex. Used to refuse importing the same file twice. */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function parseStatement(text: string, options: ImportOptions): ParsedStatement {
  if (!(CURRENCIES as readonly string[]).includes(options.currency)) throw new ImportError("unsupported_currency");
  let table: string[][];
  try {
    table = parseCsv(text);
  } catch (error) {
    if (error instanceof MalformedCsvError) throw new ImportError("csv_unreadable");
    throw error;
  }
  const [headers, ...body] = table;
  if (!headers || body.length === 0) throw new ImportError("csv_require_rows");
  const normalized = headers.map(normalizeHeader);
  const named = normalized.filter((header) => header !== "");
  if (new Set(named).size !== named.length) throw new ImportError("csv_duplicate_headers");

  const columns: Partial<Record<Column, number>> = {};
  for (const [name, aliases] of Object.entries(HEADER_ALIASES) as [keyof typeof HEADER_ALIASES, readonly string[]][]) {
    const matches = normalized.flatMap((header, index) => (aliases.includes(header) ? [index] : []));
    if (matches.length > 1) throw new ImportError("one_column_only", undefined, { column: aliases[0] });
    if (matches.length === 1) columns[name] = matches[0];
  }
  const preferredDate = DATE_COLUMN_PRIORITY.find((name) => normalized.includes(name));
  if (preferredDate) columns.date = normalized.indexOf(preferredDate);
  const hasAmount = columns.amount !== undefined || (columns.debit !== undefined && columns.credit !== undefined);
  if (columns.date === undefined || columns.description === undefined || !hasAmount) throw new ImportError("csv_required_columns");
  if (columns.amount !== undefined && (columns.debit !== undefined || columns.credit !== undefined)) throw new ImportError("csv_amount_columns");
  const balanceHeader = BALANCE_HEADERS.find((name) => normalized.includes(name));
  if (balanceHeader) columns.balance = normalized.indexOf(balanceHeader);

  // Rails quirk, kept for parity: Ruby's CSV pads the header row to the width of the
  // first data row, so extra values are only rejected after the first row.
  const headerWidth = Math.max(headers.length, body[0].length);
  const value = (fields: string[], name: Column) => {
    const index = columns[name];
    return index === undefined ? "" : (fields[index] ?? "");
  };

  const rows: ParsedTransaction[] = [];
  const balancePoints: Array<[IsoDate, number | null, number]> = [];
  // Line numbers count the header as line 1, like Rails. Blank lines were dropped by the
  // reader, so numbering follows the rows that remain.
  body.forEach((fields, offset) => {
    const line = offset + 2;
    if (fields.every((field) => field.trim() === "")) return;
    if (rows.length >= MAX_ROWS) throw new ImportError("statement_row_limit", undefined, { count: MAX_ROWS });
    if (fields.length > headerWidth) throw new ImportError("csv_extra_values", line);
    const row = parseRow(fields, line);
    rows.push(row);
    balancePoints.push([row.bookedOn, lenientBalance(value(fields, "balance")), rows.length - 1]);
  });
  if (rows.length === 0) throw new ImportError("statement_no_transactions");

  const [closingBalanceCents, closingBalanceOn] = detectedClosingBalance(balancePoints);
  return { rows, closingBalanceCents, closingBalanceOn, dateColumnUsed: headers[columns.date] ?? null };

  function parseRow(fields: string[], line: number): ParsedTransaction {
    const description = value(fields, "description").trim();
    if (description === "") throw new ImportError("row_description_required", line);
    if ([...description].length > 500) throw new ImportError("row_description_length", line);
    if (columns.currency !== undefined && value(fields, "currency").trim().toUpperCase() !== options.currency) {
      throw new ImportError("row_currency_mismatch", line, { currency: options.currency });
    }

    let amountCents: number;
    if (columns.amount !== undefined) {
      const parsed = parseMoney(value(fields, "amount"), line, false);
      if (columns.type !== undefined) {
        const type = value(fields, "type").trim().toLowerCase();
        if (["debit", "withdrawal", "expense", "dr"].includes(type)) amountCents = -Math.abs(parsed);
        else if (["credit", "deposit", "income", "cr"].includes(type)) amountCents = Math.abs(parsed);
        else if (type === "") amountCents = parsed;
        else throw new ImportError("row_invalid_type", line);
      } else {
        amountCents = parsed;
      }
    } else {
      const debit = parseMoney(value(fields, "debit"), line, true);
      const credit = parseMoney(value(fields, "credit"), line, true);
      if (debit < 0 || credit < 0 || (debit !== 0 && credit !== 0)) throw new ImportError("row_debit_credit", line);
      amountCents = credit - debit;
    }
    amountCents = amountCents === 0 ? 0 : amountCents; // no -0

    const given = value(fields, "category").trim();
    const category: Category = columns.category !== undefined && given !== ""
      ? (CATEGORIES.find((candidate) => candidate.toLowerCase() === given.toLowerCase()) ?? "Uncategorized")
      : options.categorizer.categorize(description, amountCents);
    return { bookedOn: parseDate(value(fields, "date"), line), description, amountCents, category, taxReview: category === "Business", excluded: false };
  }

  function parseMoney(raw: string, line: number, blankZero: boolean): number {
    let text = raw.trim();
    if (text === "" && blankZero) return 0;
    if (/^\([^()]+\)$/.test(text)) text = `-${text.slice(1, -1)}`;
    const symbol = /[$£€¥]/.exec(text)?.[0];
    if (symbol && !SYMBOL_CURRENCIES[symbol].includes(options.currency)) throw new ImportError("row_currency_symbol", line, { currency: options.currency });
    text = text.replace(/^([+-]?)[$£€¥]/, "$1");
    if (!/^[+-]?(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d{1,2})?$/.test(text)) throw new ImportError("row_invalid_money", line);
    const cents = decimalToCents(text.replace(/,/g, ""));
    if (Math.abs(cents) >= MONEY_LIMIT_CENTS) throw new ImportError("row_money_limit", line);
    return cents;
  }
}

function parseDate(raw: string, line: number): IsoDate {
  const text = raw.trim();
  let year: number, month: number, day: number;
  let match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (match) {
    [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  } else if ((match = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(text))) {
    [month, day, year] = [Number(match[1]), Number(match[2]), Number(match[3])];
  } else {
    throw new ImportError("row_invalid_date", line);
  }
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day || year < 1900 || year > 2100) {
    throw new ImportError("row_invalid_date", line);
  }
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/** A running-balance cell like "1,234.56", "$1,234.56" or "(50.00)"; null if not clearly a number. */
function lenientBalance(raw: string): number | null {
  let text = raw.trim();
  if (text === "") return null;
  const negative = text.startsWith("(") && text.endsWith(")");
  text = text.replace(/[()]/g, "").replace(/^([+-]?)[$£€¥]/, "$1").replace(/,/g, "");
  if (!/^[+-]?\d+(?:\.\d{1,2})?$/.test(text)) return null;
  let cents = decimalToCents(text);
  if (negative) cents = -Math.abs(cents);
  return Math.abs(cents) < MONEY_LIMIT_CENTS ? cents : null;
}

/** Balance on the latest-dated row; ties follow the file's order (oldest-first: last, newest-first: first). */
function detectedClosingBalance(points: Array<[IsoDate, number | null, number]>): [number | null, IsoDate | null] {
  if (points.length === 0) return [null, null];
  const newestFirst = points[0][0] > points[points.length - 1][0];
  let best = points[0];
  for (const point of points) {
    const better = point[0] > best[0] || (point[0] === best[0] && (newestFirst ? point[2] < best[2] : point[2] > best[2]));
    if (better) best = point;
  }
  return best[1] === null ? [null, null] : [best[1], best[0]];
}
