// Port of app/services/finance/pdf_statement_extractor.rb (row extraction, signed
// amounts, closing balance), statement_year_resolver.rb and the auto-import rule from
// statement_draft.rb. Reading text out of the PDF file is the client's job; this module
// starts from the text of each page. Error and warning codes match the Rails I18n keys
// under billie.backend.*.
import { CURRENCIES, type Currency, type IsoDate, type ParsedStatement } from "@billie/shared-types";
import type { Categorizer } from "./categorizer";
import { ImportError, parseStatement } from "./importer";
import { detectDuplicates } from "./ledger/dedupe";
import { decimalToCents, MONEY_LIMIT_CENTS } from "./money";
import type { ExistingTransaction } from "./universal/relations";
import { accountKey, type AccountKind, type AccountRef } from "./universal/schema";

export const PDF_MAX_BYTES = 2 * 1024 * 1024;
export const PDF_MAX_PAGES = 20;
export const PDF_MAX_ROWS = 500;
export const PDF_MAX_TEXT_BYTES = 512 * 1024;
export const PDF_TIMEOUT_MS = 12_000;
const MAX_WARNINGS = 1_000;

/** Notices shown with every PDF. They never block automatic import. */
export const PDF_GENERIC_NOTICES = ["pdf_generic_1", "pdf_generic_2"] as const;

/** Amount problems; Rails shows them as "Row N: <message>" (billie.backend.pdf_row_warning). */
export type PdfAmountWarningCode = "pdf_amount_currency" | "pdf_amount_markers" | "pdf_amount_unsigned" | "pdf_amount_limit" | "pdf_amount_unreadable";
export type PdfWarningCode =
  | (typeof PDF_GENERIC_NOTICES)[number] | PdfAmountWarningCode
  | "pdf_skipped_balance" | "pdf_row_two_dates" | "pdf_row_multiple_amounts" | "pdf_row_no_amount" | "pdf_row_no_description"
  | "pdf_row_shortened_description" | "pdf_uncertain_year" | "pdf_blank_pages" | "pdf_warning_limit";

export interface PdfWarning {
  code: PdfWarningCode;
  /** Values for the translated message, including `row` for row warnings. */
  vars: Record<string, string | number>;
}

/** One extracted line. `amount` is a signed decimal ("+12.34", "-5.00") or "" when it was unclear. */
export interface PdfDraftRow {
  bookedOn: IsoDate;
  description: string;
  amount: string;
  /**
   * How this row relates to what is already stored (markPdfDuplicates): "duplicate" = already
   * imported from another file of the same account (suggested: leave out), "review" = looks like
   * an existing transaction and a person decides (suggested: keep).
   */
  duplicate?: "duplicate" | "review";
}

export interface PdfDraft {
  rows: PdfDraftRow[];
  warnings: PdfWarning[];
  closingBalanceCents: number | null;
  closingBalanceOn: IsoDate | null;
  /** Nothing needs a person's attention: every amount has a clear sign, the year came from the statement, nothing was skipped. */
  autoImportable: boolean;
  /** The account the statement names (bank, last four digits, kind); `key` is null when the text does not identify exactly one. */
  account?: AccountRef;
}

export function isPdf(bytes: Uint8Array, filename: string): boolean {
  return hasPdfHeader(bytes) || filename.toLowerCase().endsWith(".pdf");
}

function hasPdfHeader(bytes: Uint8Array): boolean {
  return [0x25, 0x50, 0x44, 0x46, 0x2d].every((byte, index) => bytes[index] === byte); // "%PDF-"
}

/** The checks Rails makes on the uploaded file before reading it. */
export function checkPdfBytes(bytes: Uint8Array, filename: string): void {
  const base = filename.replace(/\\/g, "/").split("/").pop() ?? "";
  if (!base.toLowerCase().endsWith(".pdf") || [...base].length > 255) throw new ImportError("pdf_filename_limit");
  if (bytes.length === 0) throw new ImportError("pdf_empty");
  if (bytes.length > PDF_MAX_BYTES) throw new ImportError("pdf_size_limit");
  if (!hasPdfHeader(bytes)) throw new ImportError("pdf_not_readable");
}

/** Page-count and text-size limits, applied while pages are read. */
export function checkPdfPageCount(count: number): void {
  if (count < 1 || count > PDF_MAX_PAGES) throw new ImportError("pdf_page_limit", undefined, { count: PDF_MAX_PAGES });
}

const DATE_TOKEN = String.raw`(?:\d{4}-\d{2}-\d{2}|\d{1,2}/\d{1,2}(?:/\d{4})?)`;
const NUMBER_TOKEN = String.raw`(?:\d{1,3}(?:,\d{3})+|\d+)\.\d{2}`;
const MONEY_TOKEN = String.raw`(?:\(\s*[$£€¥]?${NUMBER_TOKEN}\s*\)|[+-]?\s*[$£€¥]?\s*${NUMBER_TOKEN}|[$£€¥]\s*[+-]?${NUMBER_TOKEN})(?:\s*(?:DR|CR|[+-]))?`;
// Only ending/closing balances count; a credit card's "new balance" is money owed, not cash.
const CLOSING_BALANCE = new RegExp(String.raw`\b(?:ending|closing)\s+balance\b[^\d()+-]*?([-+]?\(?\s*[$£€¥]?\s*[-+]?${NUMBER_TOKEN}\)?)(?:\s*(CR|DR)\b)?`, "i");
const DATE_ANYWHERE = new RegExp(DATE_TOKEN, "g");
const DATE_PREFIX = new RegExp(String.raw`^(${DATE_TOKEN})\s+(.+)$`);
const SECOND_DATE = new RegExp(String.raw`^${DATE_TOKEN}\s+`);
const DATE_RANGE_REST = new RegExp(String.raw`^(?:through|to|[-–—])\s*${DATE_TOKEN}$`, "i");
// Rails uses a lookbehind (?<!\S); Safari 15 cannot parse lookbehinds, so the boundary is captured instead.
const TRAILING_MONEY = new RegExp(String.raw`(^|\s)(${MONEY_TOKEN})\s*$`, "i");
const SUMMARY_DESCRIPTION = /^(?:(?:beginning|opening|ending|closing|available|current|previous)\s+(?:daily\s+)?balance|balance\s+(?:forward|brought forward)|total\s+(?:credits|debits|deposits|withdrawals|payments))\b/i;
const SYMBOL_CURRENCIES: Record<string, string[]> = { $: ["USD", "CAD", "AUD", "NZD", "SGD", "HKD"], "£": ["GBP"], "€": ["EUR"], "¥": ["JPY", "CNY"] };

export interface PdfExtractOptions {
  currency: Currency;
  /** Today's date; only used to tell which statement dates are plausible. Defaults to the device's date. */
  today?: IsoDate;
}

/** Turns the text of each PDF page into rows for review, like Rails' PdfStatementExtractor. */
export function extractPdfStatement(pages: string[], options: PdfExtractOptions): PdfDraft {
  if (!(CURRENCIES as readonly string[]).includes(options.currency)) throw new ImportError("unsupported_currency");
  checkPdfPageCount(pages.length);
  const encoder = new TextEncoder();
  let totalBytes = 0;
  for (const page of pages) {
    totalBytes += encoder.encode(page).length;
    if (totalBytes > PDF_MAX_TEXT_BYTES) throw new ImportError("pdf_text_limit");
  }
  if (pages.every(isBlank)) throw new ImportError("pdf_no_text");

  const draft = extractRows(pages.join("\n"), options);
  if (draft.rows.length === 0) throw new ImportError("pdf_no_rows");
  draft.account = pdfAccountIdentity(pages.join("\n"));
  if (pages.some(isBlank)) draft.warnings.push({ code: "pdf_blank_pages", vars: {} });
  draft.warnings = limitWarnings(uniqueWarnings(draft.warnings));
  draft.autoImportable = draft.warnings.every((warning) => (PDF_GENERIC_NOTICES as readonly string[]).includes(warning.code)) &&
    draft.rows.every((row) => row.amount !== "");
  return draft;
}

function isBlank(text: string): boolean {
  return text.trim() === "";
}

function extractRows(text: string, options: PdfExtractOptions): PdfDraft {
  const rows: PdfDraftRow[] = [];
  const warnings: PdfWarning[] = PDF_GENERIC_NOTICES.map((code) => ({ code, vars: {} }));
  // Ruby: tr(" −", " -") and drop control characters except tab/newline/CR.
  // eslint-disable-next-line no-control-regex
  const normalized = text.replace(/ /g, " ").replace(/−/g, "-").replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "");
  const resolver = new StatementYearResolver(normalized, options.today ?? localToday());
  const closingBalanceCents = detectClosingBalance(normalized);
  const closingBalanceOn = closingBalanceCents !== null && resolver.confident ? resolver.endDate : null;
  let usedPartialDates = false;

  for (const line of normalized.split("\n")) {
    const match = DATE_PREFIX.exec(rubyStrip(line));
    if (!match) continue;
    const dateText = match[1];
    let rest = rubyStrip(match[2]);
    if (DATE_RANGE_REST.test(rest)) continue;
    if (SUMMARY_DESCRIPTION.test(rest)) {
      warnings.push({ code: "pdf_skipped_balance", vars: {} });
      continue;
    }
    if (rows.length >= PDF_MAX_ROWS) throw new ImportError("pdf_candidate_limit", undefined, { count: PDF_MAX_ROWS });

    const row = rows.length + 1;
    const bookedOn = parseDate(dateText, row);
    const second = SECOND_DATE.exec(rest);
    if (second) {
      rest = rubyStrip(rest.slice(second[0].length));
      warnings.push({ code: "pdf_row_two_dates", vars: { row } });
    }
    const tokens: string[] = [];
    let amountMatch: RegExpExecArray | null;
    while ((amountMatch = TRAILING_MONEY.exec(rest)) && tokens.length < 4) {
      tokens.unshift(rubyStrip(amountMatch[2]));
      rest = rubyStrip(rest.slice(0, amountMatch.index + amountMatch[1].length));
    }

    let amount = "";
    if (tokens.length === 1) {
      const [signed, warning] = signedAmount(tokens[0], options.currency);
      amount = signed;
      if (warning) warnings.push({ code: warning, vars: { row, ...(warning === "pdf_amount_currency" ? { currency: options.currency } : {}) } });
    } else if (tokens.length > 1) {
      warnings.push({ code: "pdf_row_multiple_amounts", vars: { row } });
    } else {
      warnings.push({ code: "pdf_row_no_amount", vars: { row } });
    }
    if (rest === "") {
      rest = "Transaction - verify description";
      warnings.push({ code: "pdf_row_no_description", vars: { row } });
    } else if (rest.length > 500) {
      rest = rest.slice(0, 500);
      warnings.push({ code: "pdf_row_shortened_description", vars: { row } });
    }
    rows.push({ bookedOn, description: rest, amount });
  }
  if (usedPartialDates && !resolver.confident) warnings.push({ code: "pdf_uncertain_year", vars: { date: resolver.endDate } });
  return { rows, warnings, closingBalanceCents, closingBalanceOn, autoImportable: false };

  function parseDate(value: string, row: number): IsoDate {
    let year: number, month: number, day: number;
    let match: RegExpExecArray | null;
    if ((match = /^(\d{1,2})\/(\d{1,2})$/.exec(value))) {
      usedPartialDates = true;
      [month, day] = [Number(match[1]), Number(match[2])];
      const found = resolver.yearFor(month, day);
      if (found === null) throw new ImportError("pdf_invalid_row_date", row);
      year = found;
    } else if ((match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value))) {
      [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
    } else if ((match = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(value))) {
      [month, day, year] = [Number(match[1]), Number(match[2]), Number(match[3])];
    } else {
      throw new ImportError("pdf_invalid_row_date", row);
    }
    if (!validDate(year, month, day) || year < 1900 || year > 2100) throw new ImportError("pdf_invalid_row_date", row);
    return isoDate(year, month, day);
  }
}

/** A trailing money token as a signed decimal string, or "" with the reason it was unclear. */
function signedAmount(token: string, currency: Currency): [string, PdfAmountWarningCode | null] {
  const value = token.replace(/[ \t\r\n]/g, "");
  const symbol = /[$£€¥]/.exec(value)?.[0];
  if (symbol && !SYMBOL_CURRENCIES[symbol].includes(currency)) return ["", "pdf_amount_currency"];
  const negative = value.startsWith("(") || value.startsWith("-") || /(?:DR|dr|-)$/.test(value) || /^[$£€¥]-/.test(value);
  const positive = value.startsWith("+") || /(?:CR|cr|\+)$/.test(value) || /^[$£€¥]\+/.test(value);
  if (negative && positive) return ["", "pdf_amount_markers"];
  if (!negative && !positive) return ["", "pdf_amount_unsigned"];
  const digits = value.replace(/[()$£€¥,+-]|DR|CR/gi, "");
  const match = /^(\d+)\.(\d{2})$/.exec(digits);
  if (!match) return ["", "pdf_amount_unreadable"];
  if (Math.abs(decimalToCents(digits)) >= MONEY_LIMIT_CENTS) return ["", "pdf_amount_limit"];
  return [`${negative ? "-" : "+"}${match[1].replace(/^0+(?=\d)/, "")}.${match[2]}`, null];
}

/** The statement's closing balance in cents, or null when none is found or the PDF disagrees with itself. */
function detectClosingBalance(text: string): number | null {
  const found = new Set<number>();
  for (const line of text.split("\n")) {
    const match = CLOSING_BALANCE.exec(line.replace(DATE_ANYWHERE, " "));
    if (!match) continue;
    const token = match[1];
    const negative = token.includes("(") || token.includes("-") || match[2]?.toUpperCase() === "DR";
    const cents = decimalToCents(token.replace(/[^\d.]/g, ""));
    found.add(negative ? -cents : cents);
  }
  const [only] = [...found];
  return found.size === 1 && Math.abs(only) < MONEY_LIMIT_CENTS ? only : null;
}

/**
 * Port of statement_year_resolver.rb: which year short "MM/DD" dates belong to. The
 * closing date comes from statement-period wording when present (confident); otherwise
 * the latest plausible full date, or today (not confident).
 */
export class StatementYearResolver {
  readonly endDate: IsoDate;
  readonly confident: boolean;
  private static readonly MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
  private static readonly PERIOD_LABEL = /statement\s+(?:period|date)|billing\s+(?:period|cycle)|closing\s+date|period\s+(?:ending|covered)|for\s+the\s+period|(?:through|thru)\b|\bending\b/i;

  constructor(text: string, private readonly today: IsoDate) {
    const lines = text.split("\n");
    const labelled = this.plausible(lines.flatMap((line, index) =>
      StatementYearResolver.PERIOD_LABEL.test(line) ? this.datesIn([line, lines[index + 1]].filter((part) => part !== undefined).join(" ")) : []));
    if (labelled.length > 0) {
      this.endDate = maxDate(labelled);
      this.confident = true;
    } else {
      const any = this.plausible(this.datesIn(text));
      this.endDate = any.length > 0 ? maxDate(any) : today;
      this.confident = false;
    }
  }

  /** Year for a month/day that appears without a year, or null if it is not a real date. */
  yearFor(month: number, day: number): number | null {
    const endYear = Number(this.endDate.slice(0, 4));
    const latest = addDays(this.endDate, 7);
    for (let year = endYear; year >= endYear - 4; year -= 1) {
      if (validDate(year, month, day) && isoDate(year, month, day) <= latest) return year;
    }
    return null;
  }

  private plausible(dates: IsoDate[]): IsoDate[] {
    const latest = addDays(this.today, 45);
    const earliestYear = Number(this.today.slice(0, 4)) - 20;
    return dates.filter((date) => date <= latest && Number(date.slice(0, 4)) >= earliestYear);
  }

  private datesIn(text: string): IsoDate[] {
    const dates: Array<IsoDate | null> = [];
    for (const m of text.matchAll(/\b(\d{4})-(\d{2})-(\d{2})\b/g)) dates.push(build(m[1], m[2], m[3]));
    for (const m of text.matchAll(/\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/g)) dates.push(build(m[3], m[1], m[2]));
    const long = new RegExp(String.raw`\b(${StatementYearResolver.MONTHS.join("|")})[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})\b`, "gi");
    for (const m of text.matchAll(long)) dates.push(build(m[3], StatementYearResolver.MONTHS.indexOf(m[1].toLowerCase().slice(0, 3)) + 1, m[2]));
    return dates.filter((date): date is IsoDate => date !== null);
  }
}

function build(year: string | number, month: string | number, day: string | number): IsoDate | null {
  const [y, m, d] = [Number(year), Number(month), Number(day)];
  return validDate(y, m, d) ? isoDate(y, m, d) : null;
}

function validDate(year: number, month: number, day: number): boolean {
  const date = new Date(Date.UTC(year, month - 1, day));
  date.setUTCFullYear(year); // Date.UTC maps years 0–99 to 1900–1999
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function isoDate(year: number, month: number, day: number): IsoDate {
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function addDays(date: IsoDate, days: number): IsoDate {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

function maxDate(dates: IsoDate[]): IsoDate {
  return dates.reduce((best, date) => (date > best ? date : best));
}

function localToday(): IsoDate {
  const now = new Date();
  return isoDate(now.getFullYear(), now.getMonth() + 1, now.getDate());
}

/** Ruby String#strip: ASCII whitespace and NUL only. */
function rubyStrip(text: string): string {
  return text.replace(/^[\s\0]+|[\s\0]+$/g, "");
}

function uniqueWarnings(warnings: PdfWarning[]): PdfWarning[] {
  const seen = new Set<string>();
  return warnings.filter((warning) => {
    const key = JSON.stringify([warning.code, warning.vars]);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function limitWarnings(warnings: PdfWarning[]): PdfWarning[] {
  return warnings.length > MAX_WARNINGS ? [...warnings.slice(0, MAX_WARNINGS - 1), { code: "pdf_warning_limit", vars: {} }] : warnings;
}

export interface ReviewedPdfRow extends PdfDraftRow {
  include: boolean;
}

/**
 * Reviewed (or automatically accepted) rows as a statement, like Rails' DraftImport:
 * the included rows go through the CSV importer, so they are validated the same way.
 */
export function pdfDraftToStatement(draft: Pick<PdfDraft, "closingBalanceCents" | "closingBalanceOn">, rows: ReviewedPdfRow[],
  options: { currency: Currency; categorizer: Categorizer }): ParsedStatement {
  const included = rows.filter((row) => row.include);
  if (included.length === 0) throw new ImportError("select_transaction");
  const cell = (value: string) => `"${value.replace(/"/g, '""')}"`;
  const csv = ["Date,Description,Amount,Currency", ...included.map((row) => [row.bookedOn, row.description, row.amount, options.currency].map(cell).join(","))].join("\n");
  const parsed = parseStatement(csv, { filename: "reviewed-transactions.csv", currency: options.currency, categorizer: options.categorizer });
  return { ...parsed, closingBalanceCents: draft.closingBalanceCents, closingBalanceOn: draft.closingBalanceOn, dateColumnUsed: null };
}

// ---------------------------------------------------------------------------------------------
// Account identity and duplicates: the same evidence rules as the website
// (app/services/finance/statement_account_identity.rb `from_pdf`) and the same duplicate contract
// as every other import path (ledger/dedupe.ts detectDuplicates).

const BANK_ALIASES: ReadonlyArray<readonly [string, RegExp]> = [
  ["Chase", /\b(?:j\s*p\s*morgan\s+chase|jpmorgan\s+chase|chase)(?:\s+bank)?\b/i],
  ["Bank of America", /\b(?:bank\s+of\s+america|bofa)\b/i],
  ["Wells Fargo", /\bwells\s+fargo\b/i],
  ["Capital One", /\bcapital\s+one\b/i],
  ["Citibank", /\b(?:citibank|citi\s+bank)\b/i],
  ["U.S. Bank", /\bu\.?\s*s\.?\s+bank\b/i],
  ["PNC", /\bpnc(?:\s+bank)?\b/i],
  ["TD Bank", /\btd\s+bank\b/i],
  ["Ally Bank", /\bally\s+bank\b/i],
  ["Discover Bank", /\bdiscover\s+bank\b/i],
  ["American Express", /\bamerican\s+express\b/i],
];
const CARD_WORDS = /\b(?:credit\s+card|card\s+account|visa|mastercard|amex)\b/i;
const LOAN_WORDS = /\b(?:loan|mortgage|line\s+of\s+credit)\b/i;
const CHECKING_WORDS = /\b(?:checking|chequing)\b/i;
const SAVINGS_WORDS = /\bsavings?\b/i;
const OTHER_CASH_WORDS = /\b(?:deposit|money\s+market|cash)\b/i;
const ACCOUNT_TOKEN = "(?:[xX*\\u2022#\\d][xX*\\u2022#\\d \\t-]*\\d)";
const ACCOUNT_NUMBER = new RegExp(
  `\\b(?:account\\s*(?:number|no\\.?|#)|(?:checking|savings?|chequing)\\s+account(?:\\s*(?:number|no\\.?|#))?|card\\s*(?:number|no\\.?|#)|(?:account|card)\\s+ending\\s+(?:in\\s+)?)\\s*[:#-]?\\s*(${ACCOUNT_TOKEN})`, "gi");
const ACTIVITY_LINE = /^\s*(?:\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2}(?:\/\d{4})?)\s+/;
const EXPLICIT_BANK = /^\s*(?:bank(?:\s+name)?|financial\s+institution|institution)\s*:\s*(.{1,100})\s*$/i;

const recognizedBanks = (text: string) => BANK_ALIASES.filter(([, pattern]) => pattern.test(text)).map(([name]) => name);
const compactNumber = (value: string) => value.trim().replace(/[ \t-]/g, "");

function lastFour(value: string): string | null {
  const compact = compactNumber(value);
  if (!/^[xX*\u2022#\d]*\d{4}$/.test(compact)) return null;
  const digits = compact.replace(/\D/g, "");
  return digits.length >= 4 && digits.length <= 24 ? digits.slice(-4) : null;
}

function canonicalBank(value: string): string | null {
  const text = value.trim().replace(/\s+/g, " ");
  if (text === "" || text.length > 100) return null;
  const known = recognizedBanks(text);
  if (known.length > 1) return null;
  return known[0] ?? text.split(" ").map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()).join(" ");
}

/**
 * The account a PDF statement names. Account metadata is evidence, never a guess: date-prefixed
 * activity lines are ignored (payees often name another bank), the institution is read from the
 * first 100 lines only, and account numbers are collected from the whole document so a combined
 * statement (two accounts) is recognized as ambiguous. Only the last four digits are kept.
 * `key` is set only when exactly one bank, one number and one account kind are found.
 */
export function pdfAccountIdentity(text: string): AccountRef {
  const lines = text.split("\n");
  const headerLines = lines.slice(0, 100).filter((line) => !ACTIVITY_LINE.test(line));
  const header = headerLines.join("\n").slice(0, 12_000);
  const banks = [...new Set([...recognizedBanks(header), ...headerLines.flatMap((line) => {
    const value = EXPLICIT_BANK.exec(line)?.[1];
    const bank = value ? canonicalBank(value) : null;
    return bank ? [bank] : [];
  })])];
  const rawNumbers = [...lines.filter((line) => !ACTIVITY_LINE.test(line)).join("\n").matchAll(ACCOUNT_NUMBER)].map((match) => match[1]);
  const numbers = [...new Set(rawNumbers.flatMap((value) => lastFour(value) ?? []))];
  const fullNumbers = new Set(rawNumbers.map(compactNumber).filter((value) => /^\d{5,24}$/.test(value)));
  const ambiguous = banks.length > 1 || numbers.length > 1 || fullNumbers.size > 1;

  const card = CARD_WORDS.test(header);
  const loan = LOAN_WORDS.test(header);
  const checking = CHECKING_WORDS.test(header);
  const savings = SAVINGS_WORDS.test(header);
  const cash = checking || savings || OTHER_CASH_WORDS.test(header);
  let kind: AccountKind = "unknown";
  if ((card || loan) && !cash) kind = card ? "credit_card" : "loan";
  else if (cash && !card && !loan && checking !== savings) kind = checking ? "checking" : "savings";

  const institution = banks.length === 1 ? banks[0] : null;
  const last4 = numbers.length === 1 ? numbers[0] : null;
  const identified = institution !== null && last4 !== null && kind !== "unknown" && !ambiguous;
  return { key: identified ? accountKey(institution, last4, kind) : null, institution, last4, kind: ambiguous ? "unknown" : kind, country: null };
}

/**
 * Compares a PDF draft's rows with what is already stored, with the shared detector. Rows whose
 * amount is still unclear are not compared. Nothing is dropped here: every match is shown in the
 * review, and a draft with any match is never imported without review.
 */
export function markPdfDuplicates(draft: PdfDraft, existing: readonly ExistingTransaction[]): PdfDraft {
  const account = draft.account?.key ?? null;
  const readable = draft.rows.map((row, index) => ({ row, index })).filter(({ row }) => /^[+-]?\d+\.\d{2}$/.test(row.amount));
  const verdicts = detectDuplicates(
    existing.map((row) => ({ id: row.id, account: row.accountKey, date: row.bookedOn, amountMinor: row.amountCents, description: row.description, reference: row.bankReference })),
    readable.map(({ row }) => ({ account, date: row.bookedOn, amountMinor: decimalToCents(row.amount), description: row.description })),
  );
  const marks = new Map<number, "duplicate" | "review">();
  verdicts.forEach((verdict, position) => {
    if (verdict.result !== "new") marks.set(readable[position].index, verdict.result);
  });
  const rows = draft.rows.map(({ duplicate: _previous, ...row }, index) => (marks.has(index) ? { ...row, duplicate: marks.get(index) } : row));
  return { ...draft, rows, autoImportable: draft.autoImportable && marks.size === 0 };
}
