// Universal import on the device: CSV, TSV, Excel (.xlsx), OFX/QFX and, where the platform
// provides an on-device engine, photos/scans through OCR. Text PDFs keep their own reviewed
// path (importFile.ts). Files are read here and stay in memory until the person confirms; only
// `commitDraft` writes, and it writes atomically. Nothing in this module uses the network.
import { CURRENCIES, type Currency } from "@billie/shared-types";
import { commitPlan, createDraft, createOcrDraft, detectImage, detectRegion, ImportPipelineError, regionInputFromDraft, sha256Hex, statementHashes, type CommitBlocker, type ImportContext, type ImportDraft, type RegionDetection } from "@billie/finance-core";
import { initOcrEngine, ocrEngine } from "./ocrEngine";
import type { FinanceStore, RegionMeta } from "./store";

export class ImportBlockedError extends Error {
  code = "blocked" as const;
  constructor(public blockers: CommitBlocker[]) {
    super("blocked");
    this.name = "ImportBlockedError";
  }
}

const localToday = () => {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
};

/** `region` is the optional country/region chosen on the Import page: extra context for categorization only. */
export async function importContext(store: FinanceStore, region: string | null = null): Promise<ImportContext> {
  const [categorizer, customCategories, templates, existing, existingFileHashes, deviceCurrency] = await Promise.all([
    store.categorizer(region), store.customCategories(), store.templates(), store.dedupeIndex(), store.importedFileHashes(), store.currency(),
  ]);
  return { categorizer, customCategories, templates, existing, existingFileHashes, deviceCurrency, storableCurrencies: CURRENCIES, today: localToday(), ocr: ocrEngine() ?? (await initOcrEngine()) };
}

/**
 * Upload -> ... -> Preview. `chosenCurrency` is the currency picked on the Import page; it is only
 * a fallback when the file and the database say nothing.
 */
export async function importDraftFile(store: FinanceStore, bytes: Uint8Array, filename: string, chosenCurrency: Currency, signal?: AbortSignal, region: string | null = null): Promise<ImportDraft> {
  const context = await importContext(store, region);
  const ctx = { ...context, deviceCurrency: context.deviceCurrency ?? chosenCurrency };
  // Photos go to the on-device OCR engine (with cancellation); everything else is read directly.
  const image = detectImage(bytes);
  if (image) return createOcrDraft({ bytes, filename, format: "image", images: [{ page: 1, bytes, kind: image }], signal }, ctx);
  return createDraft(bytes, filename, ctx);
}

/**
 * Scanned PDFs. Pages that have a text layer keep the regular PDF extraction; the pages without
 * one are rendered on this device and read by the OCR engine. Returns null when every page has text.
 * `allPages` is true when the whole document is scanned (then the text extraction is skipped).
 * A partly scanned PDF gets its own hash for the OCR part so both parts can be stored.
 */
export async function importScannedPdf(store: FinanceStore, bytes: Uint8Array, filename: string, chosenCurrency: Currency, signal?: AbortSignal, region: string | null = null): Promise<{ draft: ImportDraft; allPages: boolean } | null> {
  const { findScannedPages, renderPages } = await import("./ocr/pdfRaster");
  let pages;
  try {
    pages = await findScannedPages(bytes);
  } catch {
    return null; // unreadable, encrypted, too many pages…: the regular PDF path reports it precisely
  }
  if (pages.scanned.length === 0) return null;
  const context = await importContext(store, region);
  if (!context.ocr) throw new ImportPipelineError("ocr_unavailable");
  const allPages = pages.scanned.length === pages.pageCount;
  const fileSha = await sha256Hex(bytes);
  const sha = allPages ? fileSha : await sha256Hex(new TextEncoder().encode(`${fileSha}:scanned:${pages.scanned.join(",")}`));
  let images;
  try {
    images = await renderPages(bytes, pages.scanned, signal);
  } catch (error) {
    if ((error as { name?: string } | null)?.name === "AbortError") throw new ImportPipelineError("ocr_cancelled");
    throw new ImportPipelineError("ocr_failed");
  }
  const draft = await createOcrDraft({ bytes, filename, format: "pdf_scanned", images, signal }, { ...context, deviceCurrency: context.deviceCurrency ?? chosenCurrency }, sha);
  return { draft, allPages };
}

/** Rule-based guess of the statement's country / region from the draft's own contents (never from the device). */
export function detectDraftRegion(draft: ImportDraft): RegionDetection {
  return detectRegion(regionInputFromDraft(draft));
}

/**
 * Confirm -> Commit. Throws ImportBlockedError while anything still needs a decision. The region
 * in effect (context.categorizer.region), how it was decided and the detection are saved with the statements.
 */
export async function commitDraft(store: FinanceStore, draft: ImportDraft, context: ImportContext, regionMeta?: RegionMeta) {
  const plan = commitPlan(draft, context);
  if (!plan.ok) throw new ImportBlockedError(plan.blockers);
  return store.commitImport(plan.statements, await statementHashes(plan.statements), context.categorizer.region, { detection: detectDraftRegion(draft), ...regionMeta });
}

/** Formats the universal pipeline reads directly (by content, not only by extension). */
export const UNIVERSAL_ACCEPT = ".csv,.tsv,.tab,.txt,.xlsx,.ofx,.qfx,.png,.jpg,.jpeg,.heic,.heif,.webp,.tif,.tiff,image/*,text/csv,text/tab-separated-values,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/x-ofx";
