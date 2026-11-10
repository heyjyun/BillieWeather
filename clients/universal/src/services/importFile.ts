// Import one statement file from the device into the local database.
// CSV files are imported directly. PDF statements are read on this device; when nothing
// looks unclear they are imported straight away, otherwise they come back as a draft for
// the person to review (like the website). Drafts live only in memory, never on disk.
import type { Currency } from "@billie/shared-types";
import {
  checkPdfBytes, decodeStatementBytes, detectRegion, extractPdfStatement, ImportError, isPdf, parseStatement, pdfDraftToStatement, sha256Hex,
  type PdfDraft, type RegionDetection, type RegionSource, type ReviewedPdfRow,
} from "@billie/finance-core";
import { readPdfPages } from "./pdfText";
import { StoreError, type FinanceStore, type RegionMeta } from "./store";

export interface ImportedFile {
  kind: "imported";
  /** "pdf" when a PDF was imported without review. */
  format: "csv" | "pdf";
  statementId: number;
  recategorized: number;
  count: number;
  closingBalanceCents: number | null;
}

export interface PdfReview {
  kind: "review";
  filename: string;
  currency: Currency;
  sha256: string;
  draft: PdfDraft;
  /** Optional country/region chosen on the Import page (or an accepted suggestion); null = not specified. */
  region: string | null;
  /** How `region` was decided; null with no region. */
  regionSource?: RegionSource | null;
  /** What rule-based detection found in the PDF text. */
  detection?: RegionDetection;
}

async function checkCurrency(store: FinanceStore, currency: Currency) {
  const deviceCurrency = await store.currency();
  if (deviceCurrency && deviceCurrency !== currency) {
    throw new StoreError("currency_mismatch", `This device keeps statements in ${deviceCurrency}. Delete local data to switch currency.`, { currency: deviceCurrency });
  }
}

/** Imports a CSV or a clear PDF, or returns a PDF draft that needs review. */
export async function importFile(store: FinanceStore, bytes: Uint8Array, filename: string, currency: Currency, region: string | null = null, regionMeta?: RegionMeta): Promise<ImportedFile | PdfReview> {
  await checkCurrency(store, currency);
  if (isPdf(bytes, filename)) return importPdf(store, bytes, filename, currency, region, regionMeta?.source ?? null);
  const text = decodeStatementBytes(bytes, filename);
  const parsed = parseStatement(text, { filename, currency, categorizer: await store.categorizer(region) });
  const sha256 = await sha256Hex(bytes);
  const detection = detectRegion({ text, currency, dateOrder: null });
  const result = await store.importStatement({ filename, currency, sha256, parsed, region, regionMeta: { detection, ...regionMeta } });
  return { kind: "imported", format: "csv", ...result, count: parsed.rows.length, closingBalanceCents: parsed.closingBalanceCents };
}

async function importPdf(store: FinanceStore, bytes: Uint8Array, filename: string, currency: Currency, region: string | null, regionSource: RegionSource | null): Promise<ImportedFile | PdfReview> {
  const base = filename.replace(/\\/g, "/").split("/").pop() ?? filename;
  checkPdfBytes(bytes, base);
  const sha256 = await sha256Hex(bytes);
  // Like the website: say "already imported" before spending time reading the file.
  if ((await store.statements()).some((statement) => statement.sha256 === sha256)) {
    throw new StoreError("statement_duplicate", "This statement was already imported.");
  }
  const pages = await readPdfPages(bytes);
  const draft = extractPdfStatement(pages, { currency });
  const detection = detectRegion({ text: pages.join("\n"), currency });
  const review: PdfReview = { kind: "review", filename: base, currency, sha256, draft, region, regionSource: region ? regionSource ?? "user" : null, detection };
  if (!draft.autoImportable) return review;
  try {
    return await importPdfReview(store, review, draft.rows.map((row) => ({ ...row, include: true })));
  } catch (error) {
    // Keep the draft for review if the import itself is refused (for example, a duplicate).
    if (error instanceof ImportError) return review;
    throw error;
  }
}

/** Imports the rows a person reviewed (included rows only). */
export async function importPdfReview(store: FinanceStore, review: PdfReview, rows: ReviewedPdfRow[]): Promise<ImportedFile> {
  await checkCurrency(store, review.currency);
  const parsed = pdfDraftToStatement(review.draft, rows, { currency: review.currency, categorizer: await store.categorizer(review.region) });
  const result = await store.importStatement({ filename: review.filename, currency: review.currency, sha256: review.sha256, parsed, region: review.region,
    regionMeta: { source: review.regionSource, detection: review.detection } });
  return { kind: "imported", format: "pdf", ...result, count: parsed.rows.length, closingBalanceCents: parsed.closingBalanceCents };
}
