// Receipt capture on the device: a photo, screenshot or PDF of a receipt -> recognized text lines
// (the platform's on-device OCR engine, or a PDF's own text layer) -> fields with confidences
// (parseReceiptText from @billie/finance-core) -> a person reviews -> duplicate guard against the
// local ledger (matchReceipt) -> one manual expense or refund through LedgerStore.createEntry.
//
// Nothing in this module uses the network. Sending a receipt to the website is a separate,
// explicit action (receiptUpload.ts). No receipt table is written: the saved entry is the record.
import {
  detectImage, isPdf, matchReceipt, OCR_LANGUAGES, parseMinor, parseOcrResult, parseReceiptText,
  type MatchCandidate, type MatchResult, type OcrLine, type OcrPage, type ReceiptExtraction, type ReceiptLine, type ReceiptForMatch,
} from "@billie/finance-core";
import type { Transaction } from "@billie/shared-types";
import type { Account, EntryInput } from "./ledger";
import { initOcrEngine, ocrEngine } from "./ocrEngine";

/** Larger files are refused before anything is read (a receipt photo is a few MB). */
export const MAX_RECEIPT_BYTES = 25 * 1024 * 1024;
/** Pages with at least this many non-space characters have a usable text layer (as in ocr/pdfRaster.ts). */
const MIN_PDF_TEXT = 8;
/** Receipts have one or two pages; more is a statement, not a receipt. */
const MAX_RECEIPT_PAGES = 5;

export type ReceiptErrorCode = "too_large" | "unsupported" | "ocr_unavailable" | "ocr_failed" | "cancelled" | "no_text" | "pdf_unreadable";

export class ReceiptError extends Error {
  constructor(public code: ReceiptErrorCode) {
    super(code);
    this.name = "ReceiptError";
  }
}

export interface RecognizedReceipt {
  lines: ReceiptLine[];
  /** OCR engine id ("apple-vision", "mlkit-text-v2", "tesseract-…"), or "pdf-text" for a PDF's text layer. */
  engine: string;
  source: "image" | "pdf_text" | "pdf_scanned";
}

export const localToday = (date = new Date()) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;

/**
 * Engines may return the label and the amount of one printed row as two observations ("TOTAL" on the
 * left, "48.60" on the right; Apple Vision does). Lines whose vertical centres are within half a line
 * height are one row: joined left to right, with the lowest confidence of its parts.
 */
export function receiptLinesFromPages(pages: readonly OcrPage[]): ReceiptLine[] {
  const out: ReceiptLine[] = [];
  for (const page of [...pages].sort((a, b) => a.page - b.page)) {
    const lines = page.lines.filter((line) => line.text.trim() !== "").sort((a, b) => a.y + a.height / 2 - (b.y + b.height / 2) || a.x - b.x);
    const rows: OcrLine[][] = [];
    for (const line of lines) {
      const row = rows[rows.length - 1];
      const centre = line.y + line.height / 2;
      if (row) {
        const first = row[0];
        const tolerance = Math.max(2, Math.min(first.height, line.height) / 2);
        if (Math.abs(first.y + first.height / 2 - centre) <= tolerance) {
          row.push(line);
          continue;
        }
      }
      rows.push([line]);
    }
    for (const row of rows) {
      row.sort((a, b) => a.x - b.x);
      const known = row.map((line) => line.confidence).filter((value): value is number => value !== null);
      out.push({ text: row.map((line) => line.text.trim()).join("   "), confidence: known.length === row.length ? Math.min(...known) : known.length > 0 ? Math.min(...known) : null });
    }
  }
  return out;
}

async function recognizeImages(images: Array<{ page: number; bytes: Uint8Array; kind: "png" | "jpeg" | "heic" | "webp" | "tiff" }>, signal?: AbortSignal): Promise<{ lines: ReceiptLine[]; engine: string }> {
  const engine = ocrEngine() ?? (await initOcrEngine());
  if (!engine || engine.info.location !== "device") throw new ReceiptError("ocr_unavailable");
  let raw: unknown;
  try {
    raw = await engine.recognize({ images, languages: [...OCR_LANGUAGES], signal });
  } catch (error) {
    if (signal?.aborted || (error as { name?: string } | null)?.name === "AbortError") throw new ReceiptError("cancelled");
    throw new ReceiptError("ocr_failed");
  }
  if (signal?.aborted) throw new ReceiptError("cancelled");
  const result = parseOcrResult(raw);
  const lines = receiptLinesFromPages(result.pages);
  if (lines.length === 0) throw new ReceiptError(result.errors.length > 0 ? "ocr_failed" : "no_text");
  return { lines, engine: result.engine.id || engine.info.id };
}

/** Reads one receipt file on this device. Throws ReceiptError. */
export async function recognizeReceipt(bytes: Uint8Array, filename: string, signal?: AbortSignal): Promise<RecognizedReceipt> {
  if (bytes.byteLength > MAX_RECEIPT_BYTES) throw new ReceiptError("too_large");
  const image = detectImage(bytes);
  if (image) return { ...(await recognizeImages([{ page: 1, bytes, kind: image }], signal)), source: "image" };
  if (!isPdf(bytes, filename)) throw new ReceiptError("unsupported");
  // A PDF receipt (e-mailed invoice, saved web receipt): its text layer when it has one, otherwise
  // its pages are rendered on this device and read by the OCR engine, like scanned statements.
  let pages: string[];
  try {
    const { readPdfPages } = await import("./pdfText");
    pages = await readPdfPages(bytes);
  } catch {
    throw new ReceiptError("pdf_unreadable");
  }
  if (pages.length > MAX_RECEIPT_PAGES) throw new ReceiptError("unsupported");
  if (pages.join("").replace(/\s/g, "").length >= MIN_PDF_TEXT) {
    const lines = pages.flatMap((page) => page.split("\n")).filter((text) => text.trim() !== "").map((text) => ({ text, confidence: null }));
    return { lines, engine: "pdf-text", source: "pdf_text" };
  }
  let images;
  try {
    const { renderPages } = await import("./ocr/pdfRaster");
    images = await renderPages(bytes, pages.map((_, index) => index + 1), signal);
  } catch (error) {
    if (signal?.aborted || (error as { name?: string } | null)?.name === "AbortError") throw new ReceiptError("cancelled");
    throw new ReceiptError("pdf_unreadable");
  }
  return { ...(await recognizeImages(images, signal)), source: "pdf_scanned" };
}

export function extractReceipt(lines: readonly ReceiptLine[] | string, options: { currency: string | null; today?: string }): ReceiptExtraction {
  return parseReceiptText(lines, { defaultCurrency: options.currency, today: options.today ?? localToday(), dateOrder: null });
}

// ------------------------------------------------------------------------------ review values

export type ReceiptFieldKey = "merchant" | "date" | "time" | "total" | "currency" | "tax" | "tip" | "paymentMethod" | "cardLast4" | "receiptNumber";
export const REVIEW_FIELDS: readonly ReceiptFieldKey[] = ["merchant", "date", "time", "total", "currency", "tax", "tip", "paymentMethod", "cardLast4", "receiptNumber"];

/** What the review form holds: strings as typed. Empty string = nothing. */
export type ReceiptValues = Record<ReceiptFieldKey, string> & { direction: "purchase" | "refund" };

/** How sure the reading is: `missing` (nothing read), `uncertain` (confidence below 0.8) or `read`. */
export type Certainty = "missing" | "uncertain" | "read";

export const CONFIDENT = 0.8;

export function certaintyOf(extraction: ReceiptExtraction, key: ReceiptFieldKey): Certainty {
  const field = extraction[key];
  if (field.value === null || field.value === "") return "missing";
  return field.confidence < CONFIDENT ? "uncertain" : "read";
}

export function initialValues(extraction: ReceiptExtraction): ReceiptValues {
  const values = Object.fromEntries(REVIEW_FIELDS.map((key) => [key, extraction[key].value ?? ""])) as Record<ReceiptFieldKey, string>;
  return { ...values, direction: extraction.direction };
}

/** "48.60", "48,60", "1,234.56" -> cents; null when not a plain positive amount (zero allowed for tax and tip). */
export function amountCents(text: string, allowZero = false): number | null {
  const clean = text.replace(/\s/g, "").replace(/^[+$€£¥]/, "");
  if (clean === "") return null;
  const normalized = /^\d+,\d{1,2}$/.test(clean) ? clean.replace(",", ".") : clean.replace(/,(?=\d{3}(\D|$))/g, "");
  const minor = parseMinor(normalized);
  return minor !== null && (minor > 0 || (allowZero && minor === 0)) ? minor : null;
}

const decimal = (cents: number | null) => (cents === null ? null : `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, "0")}`);

// ------------------------------------------------------------------------------ duplicate guard

/** Live ledger entries near the receipt date as matcher candidates (signed from the account's view). */
export function matchCandidates(transactions: readonly Transaction[], accounts: readonly Account[], bookCurrency: string | null): MatchCandidate[] {
  const byId = new Map(accounts.map((account) => [account.id, account]));
  return transactions.map((transaction) => {
    const account = transaction.accountId === null || transaction.accountId === undefined ? undefined : byId.get(transaction.accountId);
    return {
      id: transaction.id,
      amountMinor: transaction.amountCents,
      currency: account?.currency ?? bookCurrency,
      date: transaction.bookedOn,
      description: transaction.description,
      kind: transaction.kind ?? (transaction.amountCents > 0 ? "income" : "expense"),
      accountLast4: account?.last4 ?? null,
    };
  });
}

/** The receipt as the person confirmed it, for matching. Null when the date or total is not usable. */
export function receiptForMatch(values: ReceiptValues): ReceiptForMatch | null {
  const cents = amountCents(values.total);
  if (cents === null || !/^\d{4}-\d{2}-\d{2}$/.test(values.date)) return null;
  return {
    amountMinor: cents, direction: values.direction, currency: values.currency.trim().toUpperCase() || null, date: values.date,
    merchant: values.merchant.trim() || null, cardLast4: /^\d{4}$/.test(values.cardLast4) ? values.cardLast4 : null,
    receiptNumber: values.receiptNumber.trim() || null, tipMinor: values.tip.trim() ? amountCents(values.tip, true) : null,
    // The person reviewed and confirmed merchant, date and total before the check runs.
    confident: true,
  };
}

export function checkDuplicates(values: ReceiptValues, candidates: readonly MatchCandidate[]): MatchResult {
  const receipt = receiptForMatch(values);
  if (!receipt) return { level: "none", best: null, proposals: [] };
  return matchReceipt(receipt, candidates);
}

// ------------------------------------------------------------------------------ saving

export interface ReceiptNoteWords {
  fromReceipt: string;
  number: string;
  tax: string;
  tip: string;
}

/** The manual entry a confirmed receipt becomes: an expense (purchase) or a refund, merchant as description. */
export function entryFromReceipt(values: ReceiptValues, options: { accountId: number; category: string | null; words: ReceiptNoteWords }): EntryInput {
  const cents = amountCents(values.total);
  const merchant = values.merchant.trim() || null;
  const parts = [options.words.fromReceipt];
  if (values.receiptNumber.trim()) parts.push(options.words.number.replace("{number}", values.receiptNumber.trim()));
  const tax = decimal(values.tax.trim() ? amountCents(values.tax, true) : null);
  const tip = decimal(values.tip.trim() ? amountCents(values.tip, true) : null);
  if (tax) parts.push(options.words.tax.replace("{amount}", tax));
  if (tip) parts.push(options.words.tip.replace("{amount}", tip));
  return {
    kind: values.direction === "refund" ? "refund" : "expense",
    amountCents: cents ?? Number.NaN,
    occurredOn: values.date,
    time: /^([01]\d|2[0-3]):[0-5]\d$/.test(values.time) ? values.time : null,
    accountId: options.accountId,
    category: options.category || "Uncategorized",
    description: merchant,
    merchant,
    note: parts.join(" · "),
    // A refund from a receipt is not linked to an expense automatically (the person can link it later).
    refundOf: undefined,
  };
}

// ------------------------------------------------------------------------------ sending (payload only)

/** The website's receipt fields, from the reviewed values (decimal strings, "YYYY-MM-DD", "HH:MM"). */
export function webFields(values: ReceiptValues) {
  const money = (text: string, allowZero = false) => decimal(text.trim() ? amountCents(text, allowZero) : null);
  return {
    merchant: values.merchant.trim() || null,
    date: /^\d{4}-\d{2}-\d{2}$/.test(values.date) ? values.date : null,
    time: /^([01]\d|2[0-3]):[0-5]\d$/.test(values.time) ? values.time : null,
    total: money(values.total),
    currency: values.currency.trim().toUpperCase() || null,
    tax: money(values.tax, true),
    tip: money(values.tip, true),
    payment_method: values.paymentMethod || null,
    card_last4: /^\d{4}$/.test(values.cardLast4) ? values.cardLast4 : null,
    receipt_number: values.receiptNumber.trim() || null,
    direction: values.direction,
  };
}

export type WebReceiptFields = ReturnType<typeof webFields>;
