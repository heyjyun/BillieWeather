// Browser test harness (not part of the app build): runs the app's real on-device OCR path —
// Tesseract WebAssembly engine, pdf.js rendering of scanned pages, createOcrDraft — on synthetic
// fixtures served from this origin. Driven by test/ocr/browser.real.test.ts.
import { Categorizer, commitPlan, createOcrDraft, decisionFor, reviseDraft, type ImportContext, type OcrImage } from "@billie/finance-core";
import { CURRENCIES } from "@billie/shared-types";
import { enableOfflineOcr, tesseractForThisApp } from "../src/services/ocrEngine";
import { findScannedPages, renderPages } from "../src/services/ocr/pdfRaster";

const fixtures = new Map<string, Uint8Array>();
/** Fixtures are fetched once, so later offline runs only exercise the OCR engine's own caching. */
async function bytesOf(file: string): Promise<Uint8Array> {
  if (!fixtures.has(file)) fixtures.set(file, new Uint8Array(await (await fetch(`/test/ocr-fixtures/${file}`)).arrayBuffer()));
  return fixtures.get(file)!;
}

async function runOcr(files: string[], currency: string, script?: "zh-Hans" | "zh-Hant") {
  const engine = await tesseractForThisApp();
  let images: OcrImage[];
  let bytes: Uint8Array;
  let scanned: number[] | null = null;
  if (files[0].endsWith(".pdf")) {
    bytes = await bytesOf(files[0]);
    const pages = await findScannedPages(bytes);
    scanned = pages.scanned;
    images = await renderPages(bytes, pages.scanned);
  } else {
    images = await Promise.all(files.map(async (file, index) => ({ page: index + 1, bytes: await bytesOf(file), kind: file.endsWith(".jpg") ? "jpeg" as const : "png" as const })));
    bytes = images[0].bytes;
  }
  const context: ImportContext = {
    categorizer: new Categorizer([]), customCategories: [], templates: [], existing: [], existingFileHashes: new Set(), deviceCurrency: currency,
    storableCurrencies: CURRENCIES, today: "2026-12-31", ocr: engine,
  };
  const started = performance.now();
  let draft = await createOcrDraft({ bytes, filename: files[0], format: images.length > 1 || files[0].endsWith(".pdf") ? "pdf_scanned" : "image", images }, context);
  if (draft.needs.includes("ocrScript")) draft = reviseDraft(draft, { conventions: { ocrScript: script ?? "zh-Hans" } }, context);
  return {
    milliseconds: Math.round(performance.now() - started),
    engine: draft.ocr?.engine, unsupported: draft.ocr?.unsupported, pages: draft.ocr?.pageSizes, scanned, needs: draft.needs,
    committable: commitPlan(draft, context).ok,
    rows: draft.rows.map((row) => ({ date: row.transactionDate, amount: row.amountMinor, status: row.status, decision: decisionFor(draft, row), description: row.originalDescription, page: row.source.page })),
  };
}

Object.assign(window, { runOcr });
void enableOfflineOcr().then((controlled) => {
  document.getElementById("status")!.textContent = controlled ? "ready" : "ready-without-offline-cache";
});
