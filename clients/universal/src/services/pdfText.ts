// Reads the text of each page of a PDF statement on this device (pdf.js). The file is
// never uploaded: pdf.js gets the bytes directly, and the WebView CSP blocks any request
// it might try to make (fonts, character maps). Lines are rebuilt from text positions so
// that "date description amount" rows come out on one line, like Ruby's pdf-reader.
import { ImportError, checkPdfPageCount, PDF_TIMEOUT_MS } from "@billie/finance-core";
import type { TextItem } from "pdfjs-dist/types/src/display/api";

let pdfjs: Promise<typeof import("pdfjs-dist/legacy/build/pdf.mjs")> | undefined;
/** pdf.js is large, so it is loaded the first time a PDF is imported, not at start-up. */
function loadPdfjs() {
  pdfjs ??= (async () => {
    const lib = await import("pdfjs-dist/legacy/build/pdf.mjs");
    if (typeof window !== "undefined" && typeof Worker !== "undefined") {
      // Served from the app bundle (same origin), so the CSP's script-src 'self' allows it.
      lib.GlobalWorkerOptions.workerSrc = (await import("pdfjs-dist/legacy/build/pdf.worker.min.mjs?url")).default;
    }
    return lib;
  })();
  return pdfjs;
}

export async function readPdfPages(bytes: Uint8Array): Promise<string[]> {
  let lib: Awaited<ReturnType<typeof loadPdfjs>>;
  try {
    lib = await loadPdfjs();
  } catch {
    pdfjs = undefined; // try again next time
    throw new ImportError("pdf_unreadable");
  }
  const { getDocument, VerbosityLevel } = lib;
  const task = getDocument({
    data: bytes.slice(), // pdf.js takes ownership of the buffer
    isEvalSupported: false,
    disableFontFace: true,
    useSystemFonts: false,
    stopAtErrors: false,
    verbosity: VerbosityLevel.ERRORS, // pdf.js would otherwise log font and parsing notices
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new ImportError("pdf_timeout")), PDF_TIMEOUT_MS);
  });
  try {
    return await Promise.race([readAll(), timeout]);
  } catch (error) {
    if (error instanceof ImportError) throw error;
    // Do not show file contents or parser internals.
    if ((error as { name?: string } | null)?.name === "PasswordException") throw new ImportError("pdf_encrypted");
    throw new ImportError("pdf_unreadable");
  } finally {
    clearTimeout(timer);
    void task.destroy();
  }

  async function readAll(): Promise<string[]> {
    const pdf = await task.promise;
    checkPdfPageCount(pdf.numPages);
    const pages: string[] = [];
    for (let number = 1; number <= pdf.numPages; number += 1) {
      const page = await pdf.getPage(number);
      const content = await page.getTextContent();
      pages.push(pageText(content.items.filter((item): item is TextItem => "str" in item)));
      page.cleanup();
    }
    return pages;
  }
}

/** Groups text pieces into lines (same baseline), left to right, top to bottom. */
export function pageText(items: Array<Pick<TextItem, "str" | "transform" | "width" | "height">>): string {
  const pieces = items
    .filter((item) => item.str !== "")
    .map((item) => ({ text: item.str, x: item.transform[4], y: item.transform[5], width: item.width, size: Math.abs(item.height) || Math.abs(item.transform[3]) || 10 }));
  pieces.sort((a, b) => b.y - a.y || a.x - b.x);
  const lines: Array<typeof pieces> = [];
  for (const piece of pieces) {
    const line = lines[lines.length - 1];
    if (line && Math.abs(line[0].y - piece.y) <= Math.max(2, line[0].size * 0.4)) line.push(piece);
    else lines.push([piece]);
  }
  return lines.map((line) => {
    line.sort((a, b) => a.x - b.x);
    let text = "";
    let end = -Infinity;
    for (const piece of line) {
      const gap = piece.x - end;
      // Pieces of one word sit right next to each other; columns are further apart.
      if (text !== "" && gap > piece.size * 0.15 && !/\s$/.test(text) && !/^\s/.test(piece.text)) text += gap > piece.size * 1.5 ? "   " : " ";
      text += piece.text;
      end = piece.x + piece.width;
    }
    return text.replace(/\s+$/, "");
  }).join("\n");
}
