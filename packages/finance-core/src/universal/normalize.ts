// Extract -> Normalize -> Validate. Turns source rows into canonical transactions, recording
// every doubt as an issue instead of resolving it silently. A person's edits are applied last
// and always win over what was read or inferred.
import type { Category, IsoDate } from "@billie/shared-types";
import { CATEGORIES } from "@billie/shared-types";
import { Categorizer, merchantKey, titleizeMerchant } from "../categorizer";
import { currenciesForHint, detectDecimalSeparator, parseAmount, type DecimalDetection, type DecimalSeparator } from "./amount";
import { currencyExponent, decimalToMinor, KNOWN_CURRENCIES, spreadsheetNumberToMinor } from "./currency";
import { detectDateOrder, parseDate, type DateDetection, type DateOrder } from "./dates";
import { fieldForHeader, type ColumnMapping, type Conventions, type MappedField, type PreambleInfo } from "./mapping";
import {
  accountKey, directionOf, issue, LOW_CONFIDENCE, SCHEMA_VERSION, statusFor,
  type AccountKind, type AccountRef, type CanonicalField, type CanonicalTransaction, type Issue, type KindHint, type SourceFormat,
} from "./schema";

export interface SourceCell {
  text: string;
  /** Typed spreadsheet values: "date" text is ISO, "number" text is exact decimal with "." */
  typed?: "date" | "number";
  /** 0..1 from OCR; absent means read exactly. */
  confidence?: number;
}

export interface SourceTable {
  format: SourceFormat;
  sheet?: string;
  rows: SourceCell[][];
  /** 1-based source row (line) number of each row. */
  rowNumbers: number[];
  /** 1-based page of each row (PDF/OCR). */
  pageNumbers?: number[];
  /** Where each row is on its page image (OCR), for showing the original beside the data. */
  rowBoxes?: Array<{ x: number; y: number; width: number; height: number }>;
}

/** A person's correction of one row. Values are canonical: ISO date, "-12.34" decimal text. */
export interface RowEdit {
  transactionDate?: IsoDate;
  description?: string;
  amount?: string;
  category?: Category;
}

export interface NormalizeContext {
  fileSha256: string;
  filename: string;
  categorizer: Categorizer;
  customCategories: readonly string[];
  today: IsoDate;
  edits: Readonly<Record<string, RowEdit>>;
}

export type ConventionNeed = "mapping" | "dateOrder" | "decimal" | "amountSign" | "currency" | "ocrPages" | "ocrScript";

export interface TableNormalization {
  rows: CanonicalTransaction[];
  needs: ConventionNeed[];
  fileIssues: Issue[];
  detected: { dates: DateDetection | null; decimal: DecimalDetection | null; currency: string | null };
  effective: { dateOrder: DateOrder | null; decimal: DecimalSeparator; currency: string | null };
}

const DEBIT_WORDS = new Set(["debit", "dr", "d", "withdrawal", "expense", "out", "payment", "purchase", "sale", "charge", "soll", "s", "débit", "cargo",
  "支出", "支", "借", "出", "借方", "付", "出金", "支払", "출금", "지급"]);
const CREDIT_WORDS = new Set(["credit", "cr", "c", "deposit", "income", "in", "refund", "haben", "h", "crédit", "abono",
  "收入", "收", "贷", "貸", "入", "贷方", "貸方", "存入", "入金", "입금"]);
const PENDING_WORDS = /^(pending|authori[sz]ed|authorization|hold|processing|in process|未入账|待入账|待处理|處理中|处理中|未入帳|保留中|処理中|대기|승인대기|vorgemerkt|en attente|pendiente)$/i;
const SUMMARY_WORDS = /^(total|totals|subtotal|sum|summe|gesamt|合计|合計|小计|小計|总计|總計|本页合计|total général|totale)\b/i;

const KIND_PATTERNS: Array<[KindHint, RegExp]> = [
  ["card_payment", /payment thank you|autopay|auto pay|credit card payment|card payment|信用卡还款|信用卡還款|还款|還款|カード.*引落|카드대금/i],
  ["transfer", /\btransfer\b|\bxfer\b|\btrf\b|转账|轉帳|轉賬|转入|转出|振込|振替|이체|überweisung|umbuchung|virement|transferencia/i],
  ["refund", /\brefund\b|\breturn(ed)?\b|退款|退貨|退货|返金|환불|erstattung|gutschrift|remboursement|reembolso|devolución/i],
  ["reversal", /\brevers(al|ed)\b|\bvoid\b|冲正|沖正|撤销|撤銷|取消|storno|annulation|anulación/i],
  ["chargeback", /charge ?back|拒付|退单|退單/i],
  ["fee", /\bfee\b|\bfees\b|service charge|手续费|手續費|年费|年費|手数料|수수료|gebühr|entgelt|\bfrais\b|comisión/i],
  ["interest", /\binterest\b|利息|結息|结息|利子|이자|zinsen|intérêts|intereses/i],
  ["fx_adjustment", /foreign (transaction|exchange)|\bfx\b|currency conversion|汇兑|匯兌|结汇|結匯|購匯|购汇|為替|환전|fremdwährung|change de devise/i],
  ["cash", /\batm\b|cash withdrawal|取现|取現|提现|提現|ＡＴＭ|현금인출|bargeld|retrait/i],
];

export function kindHintsFor(description: string): KindHint[] {
  return KIND_PATTERNS.filter(([, pattern]) => pattern.test(description)).map(([kind]) => kind);
}

const cell = (row: readonly SourceCell[], index: number | undefined): SourceCell | null => (index === undefined ? null : (row[index] ?? { text: "" }));

/** Category from a file column: a built-in or custom name in any letter case, else null. */
function knownCategory(name: string, custom: readonly string[]): Category | null {
  const clean = name.trim().toLowerCase();
  if (!clean) return null;
  return CATEGORIES.find((candidate) => candidate.toLowerCase() === clean) ?? custom.find((candidate) => candidate.toLowerCase() === clean) ?? null;
}

function lowConfidence(issues: Issue[], confidence: Partial<Record<CanonicalField, number>>) {
  for (const field of ["transactionDate", "amount", "direction", "currency"] as const) {
    const value = confidence[field];
    if (value !== undefined && value < LOW_CONFIDENCE) issues.push(issue("low_confidence", "review", field, { percent: Math.round(value * 100) }));
  }
}

/** The statement currency and how it was known. Never derived from the interface language. */
export function statementCurrency(conventions: Conventions, preamble: PreambleInfo, columnValues: readonly string[], hints: readonly string[]): string | null {
  if (conventions.currency) return conventions.currency;
  if (preamble.currency && KNOWN_CURRENCIES.has(preamble.currency)) return preamble.currency;
  const column = new Set(columnValues.map((value) => value.trim().toUpperCase()).filter(Boolean));
  if (column.size === 1) {
    const [only] = column;
    if (KNOWN_CURRENCIES.has(only)) return only;
  }
  // Symbols only decide when every symbol seen points to exactly one currency.
  const options = new Set(hints.flatMap((hint) => {
    const list = currenciesForHint(hint);
    return list.length === 1 ? list : ["?"];
  }));
  if (options.size === 1 && !options.has("?")) return [...options][0];
  return null;
}

export function normalizeTable(input: {
  table: SourceTable;
  headerRow: number | null;
  headers: string[];
  mapping: ColumnMapping;
  mappingOk: boolean;
  conventions: Conventions;
  preamble: PreambleInfo;
  context: NormalizeContext;
  fallbackCurrency?: string | null;
}): TableNormalization {
  const { table, headerRow, headers, mapping, conventions, preamble, context } = input;
  const body = table.rows.map((cells, index) => ({ cells, index })).filter(({ index }) => headerRow === null || index > headerRow);
  const needs: ConventionNeed[] = input.mappingOk ? [] : ["mapping"];
  const fileIssues: Issue[] = [];

  /** Non-empty texts of a column, leaving out cells already typed as `skipTyped`. */
  const textsOf = (field: MappedField, skipTyped?: "date" | "number") => body.flatMap(({ cells }) => {
    const value = cell(cells, mapping[field]);
    return value && value.text.trim() !== "" && (skipTyped === undefined || value.typed !== skipTyped) ? [value.text] : [];
  });

  // Date order over both date columns (they share one convention).
  const dateValues = [...textsOf("transactionDate", "date"), ...textsOf("postingDate", "date")];
  const dates = input.mappingOk ? detectDateOrder(dateValues) : null;
  let dateOrder: DateOrder | null = conventions.dateOrder ?? dates?.order ?? null;
  if (dates?.conflict && !conventions.dateOrder) {
    fileIssues.push(issue("date_order_conflict", "review", "transactionDate"));
    needs.push("dateOrder");
    dateOrder = null;
  } else if (dates && ((dates.ambiguous && !conventions.dateOrder) || (dates.twoDigitYear && !conventions.dateOrder))) {
    needs.push("dateOrder");
    dateOrder = null;
  }

  // Currency first: its precision decides how "1,234" reads.
  const amountFields: MappedField[] = ["amount", "debit", "credit"];
  const amountTexts = amountFields.flatMap((field) => textsOf(field, "number"));
  const hints: string[] = [];
  for (const text of amountTexts) {
    const parsed = parseAmount(text, ".", 4);
    const parsedComma = parsed.ok ? parsed : parseAmount(text, ",", 4);
    if (parsedComma.ok && parsedComma.value.currencyHint) hints.push(parsedComma.value.currencyHint);
  }
  // The database's own currency (fixed by an earlier, confirmed import) is used only when the file says nothing.
  const currency = statementCurrency(conventions, preamble, textsOf("currency"), hints) ?? input.fallbackCurrency ?? null;
  if (!currency && input.mappingOk) needs.push("currency");
  const exponent = currency ? currencyExponent(currency) : 2;

  const decimalDetection = input.mappingOk ? detectDecimalSeparator([...amountTexts, ...textsOf("balance", "number")], exponent) : null;
  let decimal: DecimalSeparator = conventions.decimal ?? decimalDetection?.decimal ?? ".";
  if (decimalDetection?.conflict && !conventions.decimal) {
    fileIssues.push(issue("decimal_conflict", "review", "amount"));
    needs.push("decimal");
  } else if (decimalDetection?.ambiguous && !conventions.decimal) {
    needs.push("decimal");
  }
  if (conventions.decimal) decimal = conventions.decimal;

  const singleAmount = mapping.amount !== undefined && mapping.direction === undefined;
  if (input.mappingOk && singleAmount && conventions.accountKind === "credit_card" && conventions.amountSign === null) needs.push("amountSign");

  const account: AccountRef = {
    key: accountKey(preamble.institution, preamble.last4, conventions.accountKind), institution: preamble.institution, last4: preamble.last4,
    kind: conventions.accountKind, country: null,
  };

  const rows: CanonicalTransaction[] = [];
  if (!input.mappingOk) return { rows, needs, fileIssues, detected: { dates, decimal: decimalDetection, currency }, effective: { dateOrder, decimal, currency } };

  const headerKey = headers.map((header) => header.normalize("NFKC").trim().toLowerCase().replace(/\s+/g, "")).join("|");
  let repeatedHeaders = 0;
  const headerFields = headers.map((header) => fieldForHeader(header, true));
  for (const { cells, index } of body) {
    if (cells.every((value) => value.text.trim() === "")) continue;
    // Multi-page statements repeat the column headings on every page; they are not records.
    const sameText = cells.map((value) => value.text.normalize("NFKC").trim().toLowerCase().replace(/\s+/g, "")).join("|") === headerKey;
    const sameFields = headerFields.length >= 3 && cells.every((value, column) => value.text.trim() === "" || fieldForHeader(value.text, true) === (headerFields[column] ?? null)) &&
      cells.filter((value) => value.text.trim() !== "").length >= 3;
    if (headerRow !== null && headers.some(Boolean) && (sameText || sameFields)) {
      repeatedHeaders += 1;
      continue;
    }
    const id = `r${table.rowNumbers[index]}`;
    const raw: Record<string, string> = {};
    cells.forEach((value, column) => {
      if (value.text !== "") raw[headers[column] || `column ${column + 1}`] = value.text;
    });
    const issues: Issue[] = [];
    const confidence: Partial<Record<CanonicalField, number>> = {};
    const edit = context.edits[id] ?? {};

    const dateCell = cell(cells, mapping.transactionDate)!;
    const amountCells = [cell(cells, mapping.amount), cell(cells, mapping.debit), cell(cells, mapping.credit)].filter((value): value is SourceCell => value !== null);
    const descriptionText = [cell(cells, mapping.description)?.text.trim() ?? "", cell(cells, mapping.description2)?.text.trim() ?? ""].filter(Boolean).join(" / ");

    // A row with only description text continues the previous row's description (wrapped lines).
    const onlyText = dateCell.text.trim() === "" && amountCells.every((value) => value.text.trim() === "") && descriptionText !== "";
    const previous = rows[rows.length - 1];
    if (onlyText && previous && !context.edits[previous.id]?.description) {
      previous.originalDescription = `${previous.originalDescription} ${descriptionText}`.trim();
      previous.raw[`continuation ${table.rowNumbers[index]}`] = descriptionText;
      if (!previous.issues.some((item) => item.code === "continuation_merged")) previous.issues.push(issue("continuation_merged", "info", "description"));
      continue;
    }
    const firstText = cells.map((value) => value.text.trim()).find(Boolean) ?? "";
    const isSummary = SUMMARY_WORDS.test(firstText);

    // Date.
    let transactionDate: IsoDate | null = null;
    if (edit.transactionDate) {
      const parsed = parseDate(edit.transactionDate, "ymd");
      if (parsed.ok) transactionDate = parsed.iso;
      else issues.push(issue("date_invalid", "error", "transactionDate"));
      confidence.transactionDate = 1;
    } else if (dateCell.typed === "date") {
      transactionDate = dateCell.text;
      confidence.transactionDate = dateCell.confidence ?? 1;
    } else {
      const parsed = parseDate(dateCell.text, dateOrder);
      confidence.transactionDate = dateCell.confidence ?? 1;
      if (parsed.ok) transactionDate = parsed.iso;
      else if (isSummary) issues.push(issue("summary_row", "error"));
      else if (parsed.problem === "empty") issues.push(issue("date_missing", "error", "transactionDate"));
      else if (parsed.problem === "ambiguous") issues.push(issue("date_order_ambiguous", "review", "transactionDate"));
      else if (parsed.problem === "out_of_range") issues.push(issue("date_out_of_range", "error", "transactionDate"));
      else issues.push(issue(parsed.problem === "invalid" ? "date_invalid" : "date_unreadable", "error", "transactionDate"));
    }
    if (transactionDate && transactionDate > context.today) issues.push(issue("date_future", "review", "transactionDate"));

    let postingDate: IsoDate | null = null;
    const postingCell = mapping.postingDate !== undefined && mapping.postingDate !== mapping.transactionDate ? cell(cells, mapping.postingDate) : null;
    if (postingCell && postingCell.text.trim() !== "") {
      if (postingCell.typed === "date") postingDate = postingCell.text;
      else {
        const parsed = parseDate(postingCell.text, dateOrder);
        if (parsed.ok) postingDate = parsed.iso;
        else if (parsed.problem !== "ambiguous") issues.push(issue("date_unreadable", "review", "postingDate"));
      }
    }

    // Description.
    const description = edit.description !== undefined ? edit.description.trim() : descriptionText;
    if (description === "" && !isSummary) issues.push(issue("description_missing", "error", "description"));
    if ([...description].length > 500) issues.push(issue("description_too_long", "error", "description"));
    if (edit.description !== undefined) confidence.description = 1;
    else confidence.description = cell(cells, mapping.description)?.confidence ?? 1;

    // Amount and direction.
    let amountMinor: number | null = null;
    const amountConfidence = Math.min(1, ...amountCells.map((value) => value.confidence ?? 1));
    confidence.amount = amountConfidence;
    confidence.direction = amountConfidence;
    const parseOne = (value: SourceCell): { minor: number; hint: string | null; absolute: boolean; explicit: boolean } | "empty" | "unreadable" | "precision" | "too_large" => {
      if (value.text.trim() === "") return "empty";
      if (value.typed === "number") {
        const parsed = spreadsheetNumberToMinor(value.text, exponent);
        if (!parsed.ok) return parsed.problem;
        if (parsed.rounded) issues.push(issue("amount_float_rounded", "info", "amount"));
        return { minor: parsed.minor, hint: null, absolute: false, explicit: parsed.minor < 0 };
      }
      const parsed = parseAmount(value.text, decimal, exponent);
      if (!parsed.ok) return parsed.problem;
      return { minor: parsed.value.minor, hint: parsed.value.currencyHint, absolute: parsed.value.absolute, explicit: parsed.value.explicitSign !== null };
    };
    const amountProblem = (problem: string) => {
      if (problem === "empty") issues.push(issue("amount_missing", isSummary ? "info" : "error", "amount"));
      else if (problem === "precision") issues.push(issue("amount_precision", "error", "amount", { currency: currency ?? "" }));
      else if (problem === "too_large") issues.push(issue("amount_too_large", "error", "amount"));
      else issues.push(issue("amount_unreadable", "error", "amount"));
    };
    const checkHint = (hint: string | null) => {
      if (hint && currency && !currenciesForHint(hint).includes(currency)) issues.push(issue("amount_currency_conflict", "review", "amount", { currency }));
    };

    if (edit.amount !== undefined) {
      const parsed = decimalToMinor(edit.amount.trim().replace(/^\+/, ""), exponent);
      if (parsed.ok) amountMinor = parsed.minor;
      else amountProblem(parsed.problem);
      confidence.amount = 1;
      confidence.direction = 1;
    } else if (mapping.amount !== undefined) {
      const parsed = parseOne(cell(cells, mapping.amount)!);
      if (typeof parsed === "string") amountProblem(parsed);
      else {
        checkHint(parsed.hint);
        amountMinor = parsed.minor;
        const typeCell = cell(cells, mapping.direction);
        const typeText = typeCell?.text.trim().toLowerCase().normalize("NFKC") ?? "";
        if (typeCell && typeText !== "") {
          const debit = DEBIT_WORDS.has(typeText);
          const credit = CREDIT_WORDS.has(typeText);
          if (debit === credit) issues.push(issue("type_unknown", "review", "direction", { value: typeCell.text.trim().slice(0, 40) }));
          else {
            if (parsed.explicit && parsed.minor !== 0 && (parsed.minor < 0) !== debit) issues.push(issue("direction_conflict", "review", "direction"));
            amountMinor = debit ? -Math.abs(parsed.minor) : Math.abs(parsed.minor);
          }
          confidence.direction = Math.min(amountConfidence, typeCell.confidence ?? 1);
        } else if (!parsed.absolute && conventions.amountSign === "invert") {
          amountMinor = -parsed.minor;
        } else if (!parsed.absolute && singleAmount && conventions.accountKind === "credit_card" && conventions.amountSign === null) {
          issues.push(issue("sign_convention_unconfirmed", "review", "direction"));
        }
      }
    } else {
      const debitCell = cell(cells, mapping.debit);
      const creditCell = cell(cells, mapping.credit);
      const debit = debitCell ? parseOne(debitCell) : "empty";
      const credit = creditCell ? parseOne(creditCell) : "empty";
      const value = (result: typeof debit) => (typeof result === "string" ? null : result);
      for (const result of [debit, credit]) if (typeof result === "string" && result !== "empty") amountProblem(result);
      const d = value(debit);
      const c = value(credit);
      checkHint(d?.hint ?? null);
      checkHint(c?.hint ?? null);
      if (debit === "empty" && credit === "empty") amountProblem("empty");
      else if (d && c && d.minor !== 0 && c.minor !== 0) issues.push(issue("amount_both_debit_credit", "error", "amount"));
      else if ((d && d.minor < 0) || (c && c.minor < 0)) {
        // A negative figure in a debit/credit column may be a reversal: a person decides.
        issues.push(issue("amount_negative_debit_credit", "review", "amount"));
        amountMinor = (c?.minor ?? 0) - Math.abs(d?.minor ?? 0);
      } else if (d || c) {
        amountMinor = (c?.minor ?? 0) - (d?.minor ?? 0);
      }
    }
    if (amountMinor === 0) amountMinor = 0; // no -0

    // Row currency.
    const rowCurrency = cell(cells, mapping.currency)?.text.trim().toUpperCase() ?? "";
    if (rowCurrency && currency && rowCurrency !== currency) {
      issues.push(issue("foreign_currency_row", "error", "currency", { currency: rowCurrency, statement: currency }));
    }
    if (currency === null) issues.push(issue("currency_unknown", "review", "currency"));

    // Balance (optional: an unreadable balance never blocks).
    let balanceMinor: number | null = null;
    const balanceCell = cell(cells, mapping.balance);
    if (balanceCell && balanceCell.text.trim() !== "") {
      const parsed = balanceCell.typed === "number" ? spreadsheetNumberToMinor(balanceCell.text, exponent) : parseAmount(balanceCell.text, decimal, exponent);
      if (parsed.ok) balanceMinor = "minor" in parsed ? parsed.minor : parsed.value.minor;
    }

    // Status, reference, account.
    const statusText = cell(cells, mapping.status)?.text.trim() ?? "";
    const pending = PENDING_WORDS.test(statusText);
    if (pending) issues.push(issue("pending", "review", "status"));
    const bankReference = cell(cells, mapping.bankReference)?.text.trim() || null;
    let rowAccount = account;
    const accountText = cell(cells, mapping.account)?.text ?? "";
    const accountDigits = accountText.replace(/[^0-9A-Za-z]/g, "");
    if (accountDigits.length >= 4) {
      const last4 = accountDigits.slice(-4);
      rowAccount = { ...account, last4, key: accountKey(account.institution, last4, account.kind) };
      // The full number is kept nowhere, not even in the raw cells.
      const header = headers[mapping.account!] || `column ${mapping.account! + 1}`;
      if (header in raw) raw[header] = `…${last4}`;
    }

    // Category: a person's edit, then the file's own column, then rules.
    let category: Category | null = null;
    let categorySource: CanonicalTransaction["categorySource"] = null;
    if (edit.category) {
      category = edit.category;
      categorySource = "user";
    } else {
      const fromFile = knownCategory(cell(cells, mapping.category)?.text ?? "", context.customCategories);
      if (fromFile) {
        category = fromFile;
        categorySource = "file";
      } else if (amountMinor !== null && description) {
        category = context.categorizer.categorize(description, amountMinor);
        categorySource = "auto";
      }
    }

    lowConfidence(issues, confidence);
    if (Object.keys(edit).length > 0) issues.push(issue("edited_by_user", "info"));
    const kindHints = kindHintsFor(description);
    if (kindHints.includes("card_payment")) issues.push(issue("card_payment", "info"));
    if (kindHints.some((kind) => kind === "refund" || kind === "reversal" || kind === "chargeback")) issues.push(issue("refund_or_reversal", "info"));

    rows.push({
      schemaVersion: SCHEMA_VERSION, id,
      source: { format: table.format, fileSha256: context.fileSha256, filename: context.filename, row: table.rowNumbers[index], ...(table.sheet ? { sheet: table.sheet } : {}), ...(table.pageNumbers ? { page: table.pageNumbers[index] } : {}), ...(table.rowBoxes ? { box: table.rowBoxes[index] } : {}) },
      raw, account: rowAccount, transactionDate, postingDate, originalDescription: description,
      normalizedMerchant: titleizeMerchant(merchantKey(description)), amountMinor, currency, currencyExponent: exponent,
      direction: amountMinor === null ? null : directionOf(amountMinor), balanceMinor, bankReference, category, categorySource, pending, kindHints,
      confidence, issues, status: statusFor(issues),
    });
  }
  if (repeatedHeaders > 0) fileIssues.push(issue("repeated_header_skipped", "info", undefined, { count: repeatedHeaders }));
  return { rows, needs: [...new Set(needs)], fileIssues, detected: { dates, decimal: decimalDetection, currency }, effective: { dateOrder, decimal, currency } };
}

/** Re-validates after edits or relation checks added issues. */
export function refreshStatus(row: CanonicalTransaction): CanonicalTransaction {
  row.status = statusFor(row.issues);
  return row;
}

export type { AccountKind };
