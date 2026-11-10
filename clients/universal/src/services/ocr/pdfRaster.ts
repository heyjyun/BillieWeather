// Scanned PDFs: find the pages without a usable text layer and render ONLY those to PNG images
// on this device (pdf.js + canvas), in page order, for the OCR engine. Text pages keep the
// regular text extraction. OCR engines are never given a PDF file.
import { checkPdfPageCount, type OcrImage } from "@billie/finance-core";

/** Pages with fewer non-space characters than this have no usable text layer. */
export const MIN_TEXT_CHARS = 8;
/** About 300 dpi for a letter/A4 page, capped so one page never exceeds this many pixels. */
const TARGET_SCALE = 300 / 72;
const MAX_PAGE_PIXELS = 24_000_000;

export interface ScannedPages {
  pageCount: number;
  /** 1-based pages without a usable text layer. */
  scanned: number[];
}

async function loadPdf(bytes: Uint8Array) {
  const lib = await import("pdfjs-dist/legacy/build/pdf.mjs");
  if (typeof window !== "undefined" && typeof Worker !== "undefined" && !lib.GlobalWorkerOptions.workerSrc) {
    lib.GlobalWorkerOptions.workerSrc = (await import("pdfjs-dist/legacy/build/pdf.worker.min.mjs?url")).default;
  }
  return lib.getDocument({ data: bytes.slice(), isEvalSupported: false, disableFontFace: true, useSystemFonts: false, verbosity: lib.VerbosityLevel.ERRORS });
}

export async function findScannedPages(bytes: Uint8Array): Promise<ScannedPages> {
  const task = await loadPdf(bytes);
  try {
    const pdf = await task.promise;
    checkPdfPageCount(pdf.numPages);
    const scanned: number[] = [];
    for (let number = 1; number <= pdf.numPages; number += 1) {
      const page = await pdf.getPage(number);
      const content = await page.getTextContent();
      const text = content.items.map((item) => ("str" in item ? item.str : "")).join("");
      if (text.replace(/\s/g, "").length < MIN_TEXT_CHARS) scanned.push(number);
      page.cleanup();
    }
    return { pageCount: pdf.numPages, scanned };
  } finally {
    void task.destroy();
  }
}

/** Renders the given pages to PNG, one at a time (memory), checking `signal` between pages. */
export async function renderPages(bytes: Uint8Array, pages: readonly number[], signal?: AbortSignal): Promise<OcrImage[]> {
  const task = await loadPdf(bytes);
  const images: OcrImage[] = [];
  try {
    const pdf = await task.promise;
    for (const number of pages) {
      if (signal?.aborted) throw new DOMException("Cancelled", "AbortError");
      const page = await pdf.getPage(number);
      const base = page.getViewport({ scale: 1 });
      const scale = Math.min(TARGET_SCALE, Math.sqrt(MAX_PAGE_PIXELS / (base.width * base.height)));
      const viewport = page.getViewport({ scale });
      const canvas = document.createElement("canvas");
      canvas.width = Math.floor(viewport.width);
      canvas.height = Math.floor(viewport.height);
      const context = canvas.getContext("2d")!;
      context.fillStyle = "white";
      context.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvasContext: context, viewport, canvas } as never).promise;
      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
      canvas.width = 0; // release the pixels before the next page
      canvas.height = 0;
      page.cleanup();
      if (!blob) throw new Error("render_failed");
      images.push({ page: number, bytes: new Uint8Array(await blob.arrayBuffer()), kind: "png" });
    }
    return images;
  } finally {
    void task.destroy();
  }
}
