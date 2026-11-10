// The universal import pipeline:
//   Upload -> Detect -> Extract -> Normalize -> Validate -> Preview -> Confirm -> Commit
// Everything up to Confirm is pure and runs on the device. `commitPlan` is the gate: it refuses
// while any convention is unconfirmed or any row needs a decision, and otherwise returns exactly
// what the storage adapter must write (one statement per account, atomically).
import type { Category, IsoDate } from "@billie/shared-types";
import type { Categorizer } from "../categorizer";
import { sha256Hex } from "../importer";
import { detectDecimalSeparator, parseAmount, type DecimalSeparator } from "./amount";
import { currencyExponent, decimalToMinor, toStorageCents } from "./currency";
import { parseDate } from "./dates";
import {
  decodeAs, DelimitedParseError, detectDelimiter, detectEncoding, detectImage, detectKind, MAX_IMPORT_BYTES, parseDelimited,
  type DelimiterDetection, type EncodingDetection,
} from "./detect";
import {
  detectHeaderRow, mappingProblems, matchTemplate, normalizeHeaderText, proposeMapping, readPreamble,
  type ColumnMapping, type Conventions, type ImportTemplate, type MappingProblem, type PreambleInfo, type TemplateMatch,
} from "./mapping";
import { kindHintsFor, normalizeTable, type ConventionNeed, type RowEdit, type SourceCell, type SourceTable } from "./normalize";
import { layoutToTable, OCR_LANGUAGES, OcrUnavailableError, parseOcrResult, type OcrEngine, type OcrImage, type OcrResult } from "./ocr";
import { OfxError, parseOfx, type OfxDocument, type OfxStatement } from "./ofx";
import { markBalanceBreaks, markDuplicates, markRepeatedRows, markTransfers, reconcile, type ExistingTransaction } from "./relations";
import {
  accountKey, directionOf, issue, SCHEMA_VERSION, statusFor,
  type AccountKind, type BalanceObservation, type CanonicalTransaction, type Issue, type KindHint, type Reconciliation, type SourceFormat,
} from "./schema";
import { readXlsx, XlsxError, type XlsxCell } from "./xlsx";
import { merchantKey, titleizeMerchant } from "../categorizer";

export const MAX_IMPORT_ROWS = 20_000;

export type PipelineErrorCode =
  | "file_empty" | "file_too_large" | "file_duplicate" | "unsupported_format" | "not_text" | "no_rows" | "too_many_rows"
  | "ocr_unavailable" | "ocr_failed" | "ocr_cancelled" | "pdf_text_route" | "csv_unclosed_quote" | "csv_stray_quote" | "xls_legacy"
  | XlsxError["code"] | OfxError["code"];

export class ImportPipelineError extends Error {
  constructor(public code: PipelineErrorCode, public vars: Record<string, string | number> = {}) {
    super(code);
    this.name = "ImportPipelineError";
  }
}

export type ImportStage = "uploaded" | "detected" | "extracted" | "normalized" | "validated" | "previewed" | "confirmed" | "committed" | "failed" | "cancelled";

export interface ImportContext {
  categorizer: Categorizer;
  customCategories: readonly string[];
  templates: readonly ImportTemplate[];
  existing: readonly ExistingTransaction[];
  /** SHA-256 of every file already imported (refused before any parsing). */
  existingFileHashes: ReadonlySet<string>;
  /** The database's currency, fixed by its first import. */
  deviceCurrency: string | null;
  /** Currencies the storage can hold exactly. */
  storableCurrencies: readonly string[];
  today: IsoDate;
  /** The platform's on-device OCR engine, or null when this platform has none. */
  ocr: OcrEngine | null;
}

export type RowDecision = "include" | "skip";

interface TableSource {
  kind: "table";
  bytes: Uint8Array | null;
  tables: SourceTable[];
  sheetNames: string[];
  sheetIndex: number;
  encoding: EncodingDetection | null;
  delimiter: DelimiterDetection | null;
}

interface OfxSource {
  kind: "ofx";
  document: OfxDocument;
}

export interface OcrDraftInfo {
  engine: { id: string; version: string };
  unsupported: string[];
  errors: OcrResult["errors"];
  /** Pages that produced no result; importing without them needs explicit acknowledgement. */
  missingPages: number[];
  missingAcknowledged: boolean;
  images: OcrImage[];
  pageSizes: Array<{ page: number; width: number; height: number; rotation: number }>;
  /** Both Chinese readings when the engine could not tell the script apart. */
  scriptVariants: OcrResult["scriptVariants"] | null;
}

/**
 * Photos and scanned PDFs: the platform's on-device engine reads the page images (already
 * rendered, in document order), and the result goes through the same table pipeline as CSV.
 */
export async function createOcrDraft(input: { bytes: Uint8Array; filename: string; format: "image" | "pdf_scanned"; images: OcrImage[]; signal?: AbortSignal },
  context: ImportContext, knownSha256?: string): Promise<ImportDraft> {
  const name = baseName(input.filename);
  if (input.bytes.length === 0) throw new ImportPipelineError("file_empty");
  if (input.bytes.length > MAX_IMPORT_BYTES) throw new ImportPipelineError("file_too_large", { mb: MAX_IMPORT_BYTES / 1024 / 1024 });
  const fileSha256 = knownSha256 ?? (await sha256Hex(input.bytes));
  if (context.existingFileHashes.has(fileSha256)) throw new ImportPipelineError("file_duplicate");
  if (!context.ocr || context.ocr.info.location !== "device") throw new ImportPipelineError("ocr_unavailable");
  if (input.images.length === 0) throw new ImportPipelineError("no_rows");
  let result: OcrResult;
  try {
    result = parseOcrResult(await context.ocr.recognize({ images: input.images, languages: [...OCR_LANGUAGES], signal: input.signal }));
  } catch (error) {
    if (error instanceof OcrUnavailableError) throw new ImportPipelineError("ocr_unavailable");
    if ((error as { name?: string } | null)?.name === "AbortError") throw new ImportPipelineError("ocr_cancelled");
    throw new ImportPipelineError("ocr_failed");
  }
  const recognized = new Set(result.pages.map((page) => page.page));
  const missingPages = input.images.map((image) => image.page).filter((page) => !recognized.has(page));
  if (result.pages.length === 0 || result.pages.every((page) => page.lines.length === 0)) {
    throw new ImportPipelineError(result.errors.some((item) => item.code === "cancelled") ? "ocr_cancelled" : "ocr_failed");
  }
  const table = layoutToTable(result.pages, input.format);
  const draft: ImportDraft = {
    filename: name, fileSha256, format: input.format, stage: "extracted", fallbackCurrency: context.deviceCurrency,
    source: { kind: "table", bytes: null, tables: [table], sheetNames: [], sheetIndex: 0, encoding: null, delimiter: null },
    ocr: {
      engine: result.engine, unsupported: result.unsupported, errors: result.errors, missingPages, missingAcknowledged: false, images: input.images,
      pageSizes: result.pages.map(({ page, width, height, rotation }) => ({ page, width, height, rotation })),
      scriptVariants: result.scriptVariants ?? null,
    },
    headerRow: null, headers: [], mapping: {}, mappingProblems: [], mappingConfirmed: true, conventions: { ...EMPTY_CONVENTIONS }, preamble: readPreamble([]),
    templateMatch: { status: "none" }, needs: [], detected: { dateOrder: null, decimal: null, currency: null, encoding: null, delimiter: null },
    effective: { dateOrder: null, decimal: ".", currency: null }, rows: [], fileIssues: [], reconciliation: [], edits: {}, decisions: {},
    summary: { total: 0, valid: 0, needsReview: 0, rejected: 0, duplicates: 0, undecided: 0, included: 0, skipped: 0 },
  };
  setupTable(draft, context);
  return build(draft, context);
}

export interface DraftSummary {
  total: number;
  valid: number;
  needsReview: number;
  rejected: number;
  duplicates: number;
  undecided: number;
  included: number;
  skipped: number;
}

export interface ImportDraft {
  filename: string;
  fileSha256: string;
  format: SourceFormat;
  stage: ImportStage;
  /** Used only when the file names no currency: the database's currency, or the one picked before upload. */
  fallbackCurrency: string | null;
  /** OCR provenance (photos, scanned PDFs); null for every other format. Images stay in memory only. */
  ocr: OcrDraftInfo | null;
  source: TableSource | OfxSource;
  headerRow: number | null;
  headers: string[];
  mapping: ColumnMapping;
  mappingProblems: MappingProblem[];
  /** False while a saved template for this bank no longer matches the file's columns. */
  mappingConfirmed: boolean;
  /** Values a person (or a saved template) confirmed. Detected values live in `detected`. */
  conventions: Conventions;
  preamble: PreambleInfo;
  templateMatch: TemplateMatch;
  needs: ConventionNeed[];
  detected: { dateOrder: string | null; decimal: DecimalSeparator | null; currency: string | null; encoding: EncodingDetection | null; delimiter: DelimiterDetection | null };
  effective: { dateOrder: string | null; decimal: DecimalSeparator; currency: string | null };
  rows: CanonicalTransaction[];
  fileIssues: Issue[];
  reconciliation: Reconciliation[];
  edits: Record<string, RowEdit>;
  decisions: Record<string, RowDecision>;
  summary: DraftSummary;
}

const EMPTY_CONVENTIONS: Conventions = { dateOrder: null, decimal: null, amountSign: null, currency: null, accountKind: "unknown" };

function baseName(filename: string): string {
  return (filename.replace(/\\/g, "/").split("/").pop() ?? filename).slice(0, 255);
}

function xlsxCellToSource(cell: XlsxCell): SourceCell {
  switch (cell.kind) {
    case "empty": return { text: "" };
    case "string": return { text: cell.text };
    case "number": return { text: cell.text, typed: "number" };
    case "date": return { text: cell.iso, typed: "date" };
    case "boolean": return { text: cell.value ? "TRUE" : "FALSE" };
    case "error": return { text: "" };
  }
}

function textTable(text: string, format: "csv" | "tsv", delimiter: string): SourceTable {
  try {
    const parsed = parseDelimited(text, delimiter);
    return { format, rows: parsed.rows.map((row) => row.map((value) => ({ text: value }))), rowNumbers: parsed.lines };
  } catch (error) {
    if (error instanceof DelimitedParseError) throw new ImportPipelineError(error.code === "unclosed_quote" ? "csv_unclosed_quote" : "csv_stray_quote", { line: error.line });
    throw error;
  }
}

/** Upload -> Detect -> Extract. Throws ImportPipelineError for files that cannot be read at all. */
export async function createDraft(bytes: Uint8Array, filename: string, context: ImportContext): Promise<ImportDraft> {
  const name = baseName(filename);
  if (bytes.length === 0) throw new ImportPipelineError("file_empty");
  if (bytes.length > MAX_IMPORT_BYTES) throw new ImportPipelineError("file_too_large", { mb: MAX_IMPORT_BYTES / 1024 / 1024 });
  const fileSha256 = await sha256Hex(bytes);
  if (context.existingFileHashes.has(fileSha256)) throw new ImportPipelineError("file_duplicate");

  const decoded = detectImage(bytes) ? null : detectEncoding(bytes);
  const kind = detectKind(bytes, decoded?.text ?? null);
  let source: TableSource | OfxSource;
  let format: SourceFormat;
  if (kind === "pdf") throw new ImportPipelineError("pdf_text_route");
  if (kind === "xls_legacy") throw new ImportPipelineError("xls_legacy");
  if (kind === "image") {
    return createOcrDraft({ bytes, filename: name, format: "image", images: [{ page: 1, bytes, kind: detectImage(bytes)! }] }, context, fileSha256);
  } else if (kind === "xlsx") {
    let workbook;
    try {
      workbook = await readXlsx(bytes);
    } catch (error) {
      if (error instanceof XlsxError) throw new ImportPipelineError(error.code);
      throw error;
    }
    const tables = workbook.sheets.map((sheet): SourceTable => ({
      format: "xlsx", sheet: sheet.name, rows: sheet.rows.map((row) => row.map(xlsxCellToSource)), rowNumbers: sheet.rows.map((_, index) => index + 1),
    }));
    if (tables.length === 0) throw new ImportPipelineError("xlsx_no_sheets");
    const preferred = tables.findIndex((table) => detectHeaderRow(table.rows.map((row) => row.map((cell) => cell.text))) !== null);
    const firstFilled = tables.findIndex((table) => table.rows.length > 0);
    format = "xlsx";
    source = { kind: "table", bytes: null, tables, sheetNames: workbook.sheets.map((sheet) => sheet.name), sheetIndex: preferred >= 0 ? preferred : Math.max(0, firstFilled), encoding: null, delimiter: null };
  } else if (kind === "ofx" && decoded) {
    try {
      source = { kind: "ofx", document: parseOfx(decoded.text) };
    } catch (error) {
      if (error instanceof OfxError) throw new ImportPipelineError(error.code);
      throw error;
    }
    format = "ofx";
  } else if (kind === "delimited" && decoded) {
    const tsv = /\.(tsv|tab)$/i.test(name);
    const delimiter = detectDelimiter(decoded.text, tsv);
    format = delimiter.delimiter === "\t" ? "tsv" : "csv";
    source = { kind: "table", bytes, tables: [textTable(decoded.text, format, delimiter.delimiter)], sheetNames: [], sheetIndex: 0, encoding: decoded.detection, delimiter };
  } else {
    throw new ImportPipelineError(decoded === null ? "not_text" : "unsupported_format");
  }

  const draft: ImportDraft = {
    filename: name, fileSha256, format, stage: "extracted", fallbackCurrency: context.deviceCurrency, source, ocr: null, headerRow: null, headers: [], mapping: {}, mappingProblems: [], mappingConfirmed: true,
    conventions: { ...EMPTY_CONVENTIONS }, preamble: readPreamble([]), templateMatch: { status: "none" }, needs: [],
    detected: { dateOrder: null, decimal: null, currency: null, encoding: source.kind === "table" ? source.encoding : null, delimiter: source.kind === "table" ? source.delimiter : null },
    effective: { dateOrder: null, decimal: ".", currency: null }, rows: [], fileIssues: [], reconciliation: [], edits: {}, decisions: {},
    summary: { total: 0, valid: 0, needsReview: 0, rejected: 0, duplicates: 0, undecided: 0, included: 0, skipped: 0 },
  };
  if (source.kind === "table") setupTable(draft, context);
  return build(draft, context);
}

/** Header row, preamble, template and mapping proposal for the current sheet/table. */
function setupTable(draft: ImportDraft, context: ImportContext, headerRow?: number | null) {
  const source = draft.source as TableSource;
  const table = source.tables[source.sheetIndex];
  const texts = table.rows.map((row) => row.map((cell) => cell.text));
  // A saved template recognizes its own header row even when the names are not known aliases.
  const scan = texts.slice(0, 30);
  const exactRow = scan.findIndex((row) => matchTemplate(row, context.templates, null).status === "matched");
  const templateRow = exactRow >= 0 ? exactRow : scan.findIndex((row) => matchTemplate(row, context.templates, null).status === "changed");
  const tolerant = draft.ocr !== null;
  draft.headerRow = headerRow !== undefined ? headerRow : templateRow >= 0 ? templateRow : detectHeaderRow(texts, 30, tolerant);
  const width = Math.max(0, ...table.rows.map((row) => row.length));
  draft.headers = draft.headerRow === null ? Array.from({ length: width }, () => "") : Array.from({ length: width }, (_, i) => texts[draft.headerRow!][i] ?? "");
  draft.preamble = readPreamble(draft.headerRow === null ? [] : texts.slice(0, draft.headerRow));
  draft.templateMatch = draft.headerRow === null ? { status: "none" } : matchTemplate(draft.headers, context.templates, draft.preamble.institution);
  if (draft.templateMatch.status === "matched") {
    draft.mapping = draft.templateMatch.mapping;
    draft.conventions = { ...draft.templateMatch.template.conventions };
    draft.mappingConfirmed = true;
  } else {
    draft.mapping = draft.headerRow === null ? {} : proposeMapping(draft.headers, tolerant).mapping;
    draft.conventions = { ...EMPTY_CONVENTIONS, accountKind: draft.preamble.kind };
    if (draft.templateMatch.status === "changed") {
      // Prefill from the old template where its columns still exist; the person must confirm (mappingConfirmed=false).
      const normalized = draft.headers.map(normalizeHeaderText);
      for (const [field, header] of Object.entries(draft.templateMatch.template.fields) as Array<[keyof ColumnMapping, string]>) {
        const index = normalized.indexOf(header);
        if (index >= 0) draft.mapping[field] = index;
      }
    }
    draft.mappingConfirmed = draft.templateMatch.status !== "changed";
  }
}

export interface DraftChange {
  sheetIndex?: number;
  headerRow?: number | null;
  encoding?: string;
  mapping?: ColumnMapping;
  confirmMapping?: boolean;
  conventions?: Partial<Conventions>;
  /** Row id -> edit; null removes the edit. */
  edits?: Record<string, RowEdit | null>;
  decisions?: Record<string, RowDecision | null>;
  /** OCR: the person accepts importing without the pages that could not be read. */
  acknowledgeMissingPages?: boolean;
}

/** Preview edits. Returns a new draft; the old one is not modified. */
export function reviseDraft(previous: ImportDraft, change: DraftChange, context: ImportContext): ImportDraft {
  const draft: ImportDraft = { ...previous, conventions: { ...previous.conventions }, edits: { ...previous.edits }, decisions: { ...previous.decisions } };
  if (draft.source.kind === "table") {
    const source: TableSource = { ...draft.source };
    draft.source = source;
    if (change.encoding && source.bytes && source.encoding) {
      const text = decodeAs(source.bytes, change.encoding);
      if (text !== null) {
        const delimiter = detectDelimiter(text, source.delimiter?.delimiter === "\t");
        source.tables = [textTable(text, delimiter.delimiter === "\t" ? "tsv" : "csv", delimiter.delimiter)];
        source.encoding = { ...source.encoding, encoding: change.encoding, confident: true };
        source.delimiter = delimiter;
        draft.detected = { ...draft.detected, encoding: source.encoding, delimiter };
        setupTable(draft, context);
      }
    }
    if (change.sheetIndex !== undefined && change.sheetIndex !== source.sheetIndex && source.tables[change.sheetIndex]) {
      source.sheetIndex = change.sheetIndex;
      draft.edits = {};
      draft.decisions = {};
      setupTable(draft, context);
    }
    if (change.headerRow !== undefined) setupTable(draft, context, change.headerRow);
    // Re-reading the table must not silently drop settings the person already chose.
    if (draft.templateMatch.status !== "matched" && (change.encoding || change.sheetIndex !== undefined || change.headerRow !== undefined)) {
      const kept = Object.fromEntries(Object.entries(previous.conventions).filter(([, value]) => value !== null && value !== "unknown"));
      draft.conventions = { ...draft.conventions, ...kept };
    }
  }
  if (change.mapping) {
    draft.mapping = { ...change.mapping };
    draft.mappingConfirmed = true;
  }
  if (change.confirmMapping) draft.mappingConfirmed = true;
  if (change.acknowledgeMissingPages && draft.ocr) draft.ocr = { ...draft.ocr, missingAcknowledged: true };
  if (change.conventions) draft.conventions = { ...draft.conventions, ...change.conventions };
  // OCR: the chosen Chinese script selects which reading becomes the table.
  if (change.conventions?.ocrScript && draft.ocr?.scriptVariants && change.conventions.ocrScript !== previous.conventions.ocrScript) {
    const chosen = draft.conventions;
    draft.source = { ...(draft.source as TableSource), tables: [layoutToTable(draft.ocr.scriptVariants[change.conventions.ocrScript], draft.format as "image" | "pdf_scanned")] };
    setupTable(draft, context, previous.headerRow);
    draft.conventions = { ...draft.conventions, ...Object.fromEntries(Object.entries(chosen).filter(([, value]) => value !== null && value !== "unknown")) };
  }
  for (const [id, edit] of Object.entries(change.edits ?? {})) {
    if (edit === null) delete draft.edits[id];
    else draft.edits[id] = { ...draft.edits[id], ...edit };
  }
  for (const [id, decision] of Object.entries(change.decisions ?? {})) {
    if (decision === null) delete draft.decisions[id];
    else draft.decisions[id] = decision;
  }
  return build(draft, context);
}

/** Normalize -> Validate -> relations. */
function build(draft: ImportDraft, context: ImportContext): ImportDraft {
  const ofxStatements: Array<{ statement: OfxStatement; closing: BalanceObservation | null }> = [];
  if (draft.source.kind === "table") {
    const table = draft.source.tables[draft.source.sheetIndex];
    if (table.rows.length > MAX_IMPORT_ROWS) throw new ImportPipelineError("too_many_rows", { count: MAX_IMPORT_ROWS });
    draft.mappingProblems = mappingProblems(draft.mapping, draft.headers.length);
    const mappingOk = draft.mappingProblems.length === 0 && draft.mappingConfirmed;
    const result = normalizeTable({
      table, headerRow: draft.headerRow, headers: draft.headers, mapping: draft.mapping, mappingOk, conventions: draft.conventions, preamble: draft.preamble,
      context: { fileSha256: draft.fileSha256, filename: draft.filename, categorizer: context.categorizer, customCategories: context.customCategories, today: context.today, edits: draft.edits },
      fallbackCurrency: draft.fallbackCurrency,
    });
    draft.rows = result.rows;
    draft.needs = result.needs;
    draft.fileIssues = result.fileIssues;
    draft.detected = { ...draft.detected, dateOrder: result.detected.dates?.order ?? null, decimal: result.detected.decimal?.decimal ?? null, currency: result.detected.currency };
    draft.effective = result.effective;
    if (draft.source.encoding && !draft.source.encoding.confident) draft.fileIssues.push(issue("low_confidence", "review", "description", { what: "encoding" }));
  } else {
    const built = buildOfx(draft, context);
    draft.rows = built.rows;
    draft.needs = built.needs;
    draft.fileIssues = [];
    draft.effective = built.effective;
    draft.detected = { ...draft.detected, currency: built.effective.currency };
    ofxStatements.push(...built.statements);
  }

  // Relations: duplicates, transfers, balances.
  markDuplicates(draft.rows, context.existing);
  markTransfers(draft.rows, context.existing);
  const exponent = currencyExponent(draft.effective.currency ?? "USD");
  const preambleBalance = (text: string | null, kind: BalanceObservation["kind"]): BalanceObservation | null => {
    if (!text) return null;
    const parsed = parseAmount(text, draft.effective.decimal, exponent);
    return parsed.ok ? { amountMinor: parsed.value.minor, on: null, kind } : null;
  };
  if (draft.source.kind === "table") {
    draft.reconciliation = reconcile(draft.rows, { opening: preambleBalance(draft.preamble.openingBalance, "statement_opening"), closing: preambleBalance(draft.preamble.closingBalance, "statement_closing") });
  } else {
    draft.reconciliation = ofxStatements.flatMap(({ statement, closing }) => {
      const key = draft.rows.find((row) => row.id.startsWith(`o${ofxStatements.findIndex((item) => item.statement === statement)}:`))?.account.key ?? null;
      return reconcile(draft.rows.filter((row) => row.account.key === key), { closing });
    });
  }
  markBalanceBreaks(draft.rows, draft.reconciliation);
  markRepeatedRows(draft.rows);
  if (draft.ocr) {
    // Recognition confidence is not financial validation: an OCR row is only accepted as read when
    // the statement's own balances prove its amount and direction. Everything else is reviewed.
    const verified = new Set(draft.reconciliation.flatMap((item) => item.balanceVerified));
    for (const row of draft.rows) {
      if (row.status === "rejected" || verified.has(row.id) || draft.edits[row.id]?.amount !== undefined) continue;
      row.issues.push(issue("ocr_unverified", "review", "amount"));
      row.status = statusFor(row.issues);
    }
    if (draft.ocr.scriptVariants && !draft.conventions.ocrScript) draft.needs = [...draft.needs, "ocrScript"];
    if (draft.ocr.missingPages.length > 0) {
      draft.fileIssues.push(issue("ocr_page_failed", "review", undefined, { pages: draft.ocr.missingPages.join(", ") }));
      if (!draft.ocr.missingAcknowledged) draft.needs = [...draft.needs, "ocrPages"];
    }
  }
  // Once every convention is settled, a row still without a date or amount cannot be committed
  // until a person edits it in.
  if (draft.needs.length === 0) {
    for (const row of draft.rows) {
      if (row.status === "rejected") continue;
      if (row.transactionDate === null) row.issues.push(issue("date_missing", "error", "transactionDate"));
      if (row.amountMinor === null) row.issues.push(issue("amount_missing", "error", "amount"));
      else if (toStorageCents(row.amountMinor, row.currencyExponent) === null) row.issues.push(issue("currency_not_storable", "error", "amount"));
      row.status = statusFor(row.issues);
    }
  }
  draft.summary = summarize(draft);
  draft.stage = draft.needs.length > 0 ? "normalized" : "previewed";
  return draft;
}

function accountKindFromOfx(statement: OfxStatement): AccountKind {
  if (statement.kind === "creditcard") return "credit_card";
  switch (statement.accountType) {
    case "CHECKING": return "checking";
    case "SAVINGS": case "MONEYMRKT": case "CD": return "savings";
    case "CREDITLINE": return "loan";
    default: return "unknown";
  }
}

const OFX_KINDS: Record<string, KindHint> = { FEE: "fee", SRVCHG: "fee", INT: "interest", DIV: "interest", XFER: "transfer", ATM: "cash", CASH: "cash" };

function buildOfx(draft: ImportDraft, context: ImportContext) {
  const document = (draft.source as OfxSource).document;
  const needs: ConventionNeed[] = [];
  const rows: CanonicalTransaction[] = [];
  const statements: Array<{ statement: OfxStatement; closing: BalanceObservation | null }> = [];
  const currencies = new Set(document.statements.map((statement) => statement.currency ?? draft.conventions.currency).filter((value): value is string => Boolean(value)));
  const currency = draft.conventions.currency ?? (currencies.size === 1 ? [...currencies][0] : currencies.size === 0 ? draft.fallbackCurrency : null);
  if (!currency) needs.push("currency");
  const exponent = currencyExponent(currency ?? "USD");
  const amounts = document.statements.flatMap((statement) => statement.transactions.map((transaction) => transaction.amount));
  const decimalDetection = detectDecimalSeparator(amounts, exponent);
  const decimal: DecimalSeparator = draft.conventions.decimal ?? decimalDetection.decimal ?? ".";
  if ((decimalDetection.ambiguous || decimalDetection.conflict) && !draft.conventions.decimal) needs.push("decimal");

  document.statements.forEach((statement, statementIndex) => {
    const kind = accountKindFromOfx(statement);
    const institution = document.institution.org ?? statement.bankId;
    const account = { key: accountKey(institution, statement.accountLast4, kind), institution, last4: statement.accountLast4, kind, country: null };
    const statementCurrency = statement.currency ?? currency;
    if (statementCurrency && currency && statementCurrency !== currency) {
      // One statement per currency per database: a different-currency account cannot be stored here.
      for (const transaction of statement.transactions) rows.push(ofxRow(statementIndex, transaction, account, statementCurrency, ["foreign_currency_row"]));
      return;
    }
    let closing: BalanceObservation | null = null;
    if (statement.ledgerBalance) {
      const parsed = parseAmount(statement.ledgerBalance.amount, decimal, exponent);
      if (parsed.ok) closing = { amountMinor: parsed.value.minor, on: statement.ledgerBalance.asOf, kind: "statement_closing" };
    }
    statements.push({ statement, closing });
    for (const transaction of statement.transactions) rows.push(ofxRow(statementIndex, transaction, account, currency, []));
  });

  function ofxRow(statementIndex: number, transaction: OfxStatement["transactions"][number], account: CanonicalTransaction["account"], rowCurrency: string | null, forced: Array<"foreign_currency_row">): CanonicalTransaction {
    const id = `o${statementIndex}:${transaction.index}`;
    const edit = draft.edits[id] ?? {};
    const issues: Issue[] = forced.map((code) => issue(code, "error", "currency", { currency: rowCurrency ?? "", statement: currency ?? "" }));
    const name = transaction.name ?? transaction.payee ?? "";
    const memo = transaction.memo && transaction.memo !== name ? transaction.memo : "";
    const description = edit.description?.trim() ?? [name, memo].filter(Boolean).join(" / ");
    if (!description) issues.push(issue("description_missing", "error", "description"));
    if ([...description].length > 500) issues.push(issue("description_too_long", "error", "description"));
    let transactionDate = transaction.userDate ?? transaction.posted;
    if (edit.transactionDate) {
      const parsed = parseDate(edit.transactionDate, "ymd");
      transactionDate = parsed.ok ? parsed.iso : null;
    }
    if (!transactionDate) issues.push(issue("date_missing", "error", "transactionDate"));
    else if (transactionDate > context.today) issues.push(issue("date_future", "review", "transactionDate"));
    let amountMinor: number | null = null;
    if (edit.amount !== undefined) {
      const parsed = decimalToMinor(edit.amount.trim().replace(/^\+/, ""), exponent);
      if (parsed.ok) amountMinor = parsed.minor;
      else issues.push(issue(parsed.problem === "precision" ? "amount_precision" : "amount_unreadable", "error", "amount"));
    } else {
      const parsed = parseAmount(transaction.amount, decimal, exponent);
      if (parsed.ok) amountMinor = parsed.value.minor === 0 ? 0 : parsed.value.minor;
      else if (parsed.problem === "empty") issues.push(issue("amount_missing", "error", "amount"));
      else issues.push(issue(parsed.problem === "precision" ? "amount_precision" : parsed.problem === "too_large" ? "amount_too_large" : "amount_unreadable", "error", "amount", { currency: currency ?? "" }));
    }
    if (transaction.currency && !transaction.originalCurrency && currency && transaction.currency !== currency && forced.length === 0) {
      issues.push(issue("foreign_currency_row", "error", "currency", { currency: transaction.currency, statement: currency }));
    }
    if (!currency) issues.push(issue("currency_unknown", "review", "currency"));
    const kindHints = [...new Set([...(OFX_KINDS[transaction.trnType] ? [OFX_KINDS[transaction.trnType]] : []), ...kindHintsFor(description)])];
    if (transaction.originalCurrency && !kindHints.includes("fx_adjustment")) kindHints.push("fx_adjustment");
    if (transaction.trnType === "PAYMENT" && account.kind === "credit_card" && !kindHints.includes("card_payment")) kindHints.push("card_payment");
    if (transaction.correctAction) issues.push(issue("refund_or_reversal", "review", undefined, { action: transaction.correctAction }));
    else if (kindHints.some((kind) => kind === "refund" || kind === "reversal" || kind === "chargeback")) issues.push(issue("refund_or_reversal", "info"));
    if (kindHints.includes("card_payment")) issues.push(issue("card_payment", "info"));
    let category: Category | null = null;
    let categorySource: CanonicalTransaction["categorySource"] = null;
    if (edit.category) {
      category = edit.category;
      categorySource = "user";
    } else if (amountMinor !== null && description) {
      const decided = context.categorizer.explain(description, amountMinor);
      category = decided.category;
      categorySource = decided.reason === "region" ? "region" : "auto";
    }
    if (Object.keys(edit).length > 0) issues.push(issue("edited_by_user", "info"));
    const raw: Record<string, string> = { TRNTYPE: transaction.trnType, TRNAMT: transaction.amount };
    for (const [key, value] of [["DTPOSTED", transaction.posted], ["DTUSER", transaction.userDate], ["FITID", transaction.fitId], ["NAME", transaction.name],
      ["MEMO", transaction.memo], ["CHECKNUM", transaction.checkNum], ["CURRATE", transaction.currencyRate], ["CURSYM", transaction.currency]] as const) {
      if (value) raw[key] = value;
    }
    return {
      schemaVersion: SCHEMA_VERSION, id, source: { format: "ofx", fileSha256: draft.fileSha256, filename: draft.filename, row: transaction.sourceLine },
      raw, account, transactionDate, postingDate: transaction.posted, originalDescription: description, normalizedMerchant: titleizeMerchant(merchantKey(description)),
      amountMinor, currency: rowCurrency, currencyExponent: currencyExponent(rowCurrency ?? "USD"), direction: amountMinor === null ? null : directionOf(amountMinor),
      balanceMinor: null, bankReference: transaction.fitId, category, categorySource, pending: false, kindHints,
      confidence: { transactionDate: 1, amount: 1, direction: 1, description: 1 }, issues, status: statusFor(issues),
    };
  }
  return { rows, needs: [...new Set(needs)], statements, effective: { dateOrder: "ymd", decimal, currency } };
}

/** "include", "skip", or "undecided" when a person still has to choose. */
export function decisionFor(draft: Pick<ImportDraft, "decisions">, row: CanonicalTransaction): RowDecision | "undecided" {
  if (row.status === "rejected") return "skip";
  const chosen = draft.decisions[row.id];
  if (chosen) return chosen;
  if (row.issues.some((item) => item.code === "duplicate_bank_reference")) return "skip";
  return row.status === "valid" ? "include" : "undecided";
}

/** What the preview recommends for a row that needs review (applied only when the person asks). */
export function suggestedDecision(row: CanonicalTransaction): RowDecision {
  const skipCodes = new Set(["duplicate_overlap", "duplicate_bank_reference", "possible_duplicate", "repeated_bank_reference_in_file", "pending"]);
  return row.issues.some((item) => skipCodes.has(item.code)) ? "skip" : "include";
}

const DUPLICATE_CODES = new Set(["duplicate_overlap", "duplicate_bank_reference", "possible_duplicate", "repeated_bank_reference_in_file"]);

function summarize(draft: ImportDraft): DraftSummary {
  const summary: DraftSummary = { total: draft.rows.length, valid: 0, needsReview: 0, rejected: 0, duplicates: 0, undecided: 0, included: 0, skipped: 0 };
  for (const row of draft.rows) {
    if (row.status === "valid") summary.valid += 1;
    else if (row.status === "needs_review") summary.needsReview += 1;
    else summary.rejected += 1;
    if (row.issues.some((item) => DUPLICATE_CODES.has(item.code))) summary.duplicates += 1;
    const decision = decisionFor(draft, row);
    if (decision === "undecided") summary.undecided += 1;
    else if (decision === "include") summary.included += 1;
    else summary.skipped += 1;
  }
  return summary;
}

export type CommitBlocker =
  | { code: "needs"; needs: ConventionNeed[] }
  | { code: "undecided_rows"; count: number }
  | { code: "currency_not_storable"; currency: string }
  | { code: "currency_mismatch_device"; currency: string; device: string }
  | { code: "nothing_to_import" };

export interface PlannedRow {
  bookedOn: IsoDate;
  postedOn: IsoDate | null;
  description: string;
  normalizedMerchant: string | null;
  amountCents: number;
  currency: string;
  direction: "debit" | "credit" | "zero";
  balanceCents: number | null;
  bankReference: string | null;
  accountKey: string | null;
  category: Category;
  categorySource: "user" | "rule" | "file" | "auto" | "region";
  taxReview: boolean;
  pending: boolean;
  kindHints: string;
  sourceRef: string;
  /** 0..100, the lowest field confidence. */
  confidence: number;
  /** "verified": read cleanly. "user_confirmed": a person reviewed, edited or accepted a doubt. */
  validationStatus: "verified" | "user_confirmed";
  raw: string;
}

export interface ImportReport {
  schemaVersion: typeof SCHEMA_VERSION;
  format: SourceFormat;
  sourceSha256: string;
  totalRows: number;
  accepted: number;
  skippedDuplicates: number;
  skippedByUser: number;
  rejected: Array<{ row: number; codes: string[] }>;
  userConfirmed: number;
  edited: number;
  reconciliation: { differenceMinor: number | null; runningBalanceBreaks: number } | null;
  conventions: Conventions & { encoding: string | null; delimiter: string | null };
  templateId: string | null;
}

export interface PlannedStatement {
  account: CanonicalTransaction["account"];
  currency: string;
  filename: string;
  sourceSha256: string;
  format: SourceFormat;
  rows: PlannedRow[];
  closingBalanceCents: number | null;
  closingBalanceOn: IsoDate | null;
  openingBalanceCents: number | null;
  openingBalanceOn: IsoDate | null;
  report: ImportReport;
}

/** Confirm: what will be written, or why nothing may be written yet. */
export function commitPlan(draft: ImportDraft, context: Pick<ImportContext, "deviceCurrency" | "storableCurrencies">): { ok: true; statements: PlannedStatement[] } | { ok: false; blockers: CommitBlocker[] } {
  const blockers: CommitBlocker[] = [];
  if (draft.needs.length > 0) blockers.push({ code: "needs", needs: draft.needs });
  if (draft.summary.undecided > 0) blockers.push({ code: "undecided_rows", count: draft.summary.undecided });
  const currency = draft.effective.currency;
  if (currency && !context.storableCurrencies.includes(currency)) blockers.push({ code: "currency_not_storable", currency });
  if (currency && context.deviceCurrency && currency !== context.deviceCurrency) blockers.push({ code: "currency_mismatch_device", currency, device: context.deviceCurrency });
  const included = draft.rows.filter((row) => decisionFor(draft, row) === "include");
  if (blockers.length === 0 && included.length === 0) blockers.push({ code: "nothing_to_import" });
  if (blockers.length > 0 || !currency) return { ok: false, blockers };

  const groups = new Map<string, CanonicalTransaction[]>();
  for (const row of draft.rows) {
    const list = groups.get(row.account.key ?? "");
    if (list) list.push(row);
    else groups.set(row.account.key ?? "", [row]);
  }
  const statements: PlannedStatement[] = [];
  for (const [key, group] of groups) {
    const accepted = group.filter((row) => decisionFor(draft, row) === "include");
    if (accepted.length === 0) continue;
    const plannedRows = accepted.map((row): PlannedRow => {
      const amountCents = toStorageCents(row.amountMinor!, row.currencyExponent);
      if (amountCents === null || !row.transactionDate) throw new Error("commitPlan: an included row is not storable"); // unreachable: rejected rows are never included
      const balanceCents = row.balanceMinor === null ? null : toStorageCents(row.balanceMinor, row.currencyExponent);
      const category = row.category ?? "Uncategorized";
      const confidences = Object.values(row.confidence).filter((value): value is number => value !== undefined);
      const reviewed = row.status !== "valid" || row.issues.some((item) => item.code === "edited_by_user");
      return {
        bookedOn: row.transactionDate, postedOn: row.postingDate, description: row.originalDescription, normalizedMerchant: row.normalizedMerchant, amountCents,
        currency, direction: directionOf(row.amountMinor!), balanceCents, bankReference: row.bankReference, accountKey: row.account.key, category,
        categorySource: row.categorySource ?? "auto", taxReview: category === "Business", pending: row.pending, kindHints: row.kindHints.join(","),
        sourceRef: [row.source.sheet ? `sheet:${row.source.sheet}` : null, row.source.page ? `page:${row.source.page}` : null, `row:${row.source.row}`].filter(Boolean).join(" "),
        confidence: Math.round(Math.min(1, ...confidences) * 100), validationStatus: reviewed ? "user_confirmed" : "verified",
        raw: JSON.stringify(row.raw).slice(0, 4000),
      };
    });
    const reconciliation = draft.reconciliation.find((item) => (item.accountKey ?? "") === key) ?? null;
    const exponent = currencyExponent(currency);
    const balance = (observation: BalanceObservation | null | undefined) => (observation ? toStorageCents(observation.amountMinor, exponent) : null);
    // A closing balance is only trusted when the running balance is consistent.
    const closingTrusted = reconciliation?.closing && (reconciliation.closing.kind === "statement_closing" || reconciliation.runningBalanceBreaks.length === 0);
    statements.push({
      account: group[0].account, currency, filename: draft.filename, sourceSha256: draft.fileSha256, format: draft.format, rows: plannedRows,
      closingBalanceCents: closingTrusted ? balance(reconciliation!.closing) : null,
      closingBalanceOn: closingTrusted ? (reconciliation!.closing!.on ?? plannedRows.reduce((max, row) => (row.bookedOn > max ? row.bookedOn : max), plannedRows[0].bookedOn)) : null,
      openingBalanceCents: balance(reconciliation?.opening), openingBalanceOn: reconciliation?.opening?.on ?? null,
      report: {
        schemaVersion: SCHEMA_VERSION, format: draft.format, sourceSha256: draft.fileSha256, totalRows: group.length, accepted: accepted.length,
        skippedDuplicates: group.filter((row) => decisionFor(draft, row) === "skip" && row.status !== "rejected" && row.issues.some((item) => DUPLICATE_CODES.has(item.code))).length,
        skippedByUser: group.filter((row) => decisionFor(draft, row) === "skip" && row.status !== "rejected" && !row.issues.some((item) => DUPLICATE_CODES.has(item.code))).length,
        rejected: group.filter((row) => row.status === "rejected").map((row) => ({ row: row.source.row, codes: row.issues.filter((item) => item.severity === "error").map((item) => item.code) })),
        userConfirmed: plannedRows.filter((row) => row.validationStatus === "user_confirmed").length,
        edited: accepted.filter((row) => draft.edits[row.id]).length,
        reconciliation: reconciliation ? { differenceMinor: reconciliation.differenceMinor, runningBalanceBreaks: reconciliation.runningBalanceBreaks.length } : null,
        conventions: { ...draft.conventions, dateOrder: draft.conventions.dateOrder ?? (draft.effective.dateOrder as Conventions["dateOrder"]), decimal: draft.effective.decimal, currency,
          encoding: draft.detected.encoding?.encoding ?? null, delimiter: draft.detected.delimiter?.delimiter ?? null },
        templateId: draft.templateMatch.status === "matched" ? draft.templateMatch.template.id : null,
      },
    });
  }
  return { ok: true, statements };
}

/**
 * Statements need distinct file hashes (the column is unique). A single-account file keeps the
 * file's SHA-256; each account of a multi-account file gets SHA-256(file hash + ":" + account).
 */
export async function statementHashes(plan: readonly PlannedStatement[]): Promise<string[]> {
  if (plan.length === 1) return [plan[0].sourceSha256];
  return Promise.all(plan.map((statement) => sha256Hex(new TextEncoder().encode(`${statement.sourceSha256}:${statement.account.key ?? ""}`))));
}

