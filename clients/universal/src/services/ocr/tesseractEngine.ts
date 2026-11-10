// Tesseract (WebAssembly, via tesseract.js) as an on-device OCR engine. Used in the browser and
// in Tauri desktop builds without a native engine (Windows WebView2, Linux). Everything it loads
// is shipped with the app and served from the app's own origin (see `ocrAssets` in
// vite.config.ts): the worker script, the WASM core and the eng/chi_sim/chi_tra models.
// tesseract.js falls back to the jsDelivr CDN when corePath/langPath are missing, so this module
// refuses to start without them. Images and recognized text never leave the device.
import { OCR_LANGUAGES, type OcrElement, type OcrEngine, type OcrImage, type OcrLine, type OcrPage, type OcrResult } from "@billie/finance-core";
import { imageSize } from "./imageSize";

const LANGUAGE_DATA: Record<string, string> = { en: "eng", "zh-Hans": "chi_sim", "zh-Hant": "chi_tra" };
export const TESSERACT_VERSION = "tesseract.js 7.0.0 (tesseract-core 7.0.0, 4.0.0_best_int models)";

export interface TesseractAssets {
  /** URL (browser) or file path (Node tests) of worker.min.js. Unused in Node. */
  workerPath: string;
  /** Directory URL with tesseract-core-*-lstm.wasm.js (browser). Unused in Node. */
  corePath: string;
  /** Directory URL or path with <lang>.traineddata.gz. */
  langPath: string;
  /** "write": keep models in IndexedDB for offline use (browser). "none": nothing is stored. */
  cacheMethod: "write" | "none";
  /** Rotates images for the quarter-turn probe (needs a canvas); omitted where unavailable. */
  rotate?: (image: OcrImage, degrees: 90 | 180 | 270) => Promise<Uint8Array>;
}

interface TesseractWord { text: string; confidence: number; bbox: { x0: number; y0: number; x1: number; y1: number } }
interface TesseractLine extends TesseractWord { words: TesseractWord[] }
interface TesseractBlock { paragraphs: Array<{ lines: TesseractLine[] }> }

function element(item: TesseractWord): OcrElement {
  const { x0, y0, x1, y1 } = item.bbox;
  return { text: item.text.trim(), confidence: Number.isFinite(item.confidence) ? Math.min(1, Math.max(0, item.confidence / 100)) : null, x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

const CJK = /[\u3400-\u9fff\uf900-\ufaff]/u;

/**
 * Tesseract returns Chinese text one glyph per "word". Glyphs of one word sit closer together than
 * half a glyph height; those are joined without a space (a real space keeps them apart).
 */
function joinCjk(words: OcrElement[]): OcrElement[] {
  const out: OcrElement[] = [];
  for (const word of words) {
    const previous = out[out.length - 1];
    const gap = previous ? word.x - (previous.x + previous.width) : Infinity;
    if (previous && CJK.test(previous.text.slice(-1)) && CJK.test(word.text[0]) && gap < Math.max(previous.height, word.height) * 0.5) {
      const right = Math.max(previous.x + previous.width, word.x + word.width);
      const bottom = Math.max(previous.y + previous.height, word.y + word.height);
      const top = Math.min(previous.y, word.y);
      out[out.length - 1] = {
        text: previous.text + word.text, x: previous.x, y: top, width: right - previous.x, height: bottom - top,
        confidence: previous.confidence === null || word.confidence === null ? null : Math.min(previous.confidence, word.confidence),
      };
    } else {
      out.push(word);
    }
  }
  return out;
}

function linesOf(blocks: TesseractBlock[] | null): OcrLine[] {
  return (blocks ?? []).flatMap((block) => block.paragraphs.flatMap((paragraph) => paragraph.lines.map((line) => {
    const words = joinCjk(line.words.map(element).filter((word) => word.text !== ""));
    return { ...element(line), text: words.map((word) => word.text).join(" "), words };
  }))).filter((line) => line.text !== "");
}



/**
 * Used to pick the upright orientation: confidence summed over words read confidently (>= 0.7).
 * A sideways page yields many low-confidence garbage words, which must not outweigh fewer clean ones.
 */
function quality(lines: OcrLine[]): number {
  return lines.flatMap((line) => line.words).filter((word) => (word.confidence ?? 0) >= 0.7 && /[\p{L}\p{N}]/u.test(word.text))
    .reduce((sum, word) => sum + (word.confidence ?? 0), 0);
}

export function tesseractEngine(assets: TesseractAssets): OcrEngine {
  if (!assets.corePath || !assets.langPath || !assets.workerPath) throw new Error("Tesseract assets must be local paths; refusing to fall back to a CDN.");
  return {
    info: { id: "tesseract-js", location: "device", languages: [...OCR_LANGUAGES] },
    async recognize({ images, languages, signal }): Promise<OcrResult> {
      const codes = languages.map((language) => LANGUAGE_DATA[language]).filter(Boolean);
      const unsupported = languages.filter((language) => !LANGUAGE_DATA[language]).map((language) => `language:${language}`);
      const result: OcrResult = { engine: { id: "tesseract-js", version: TESSERACT_VERSION }, languages, pages: [], errors: [], unsupported };
      if (!assets.rotate) result.unsupported.push("rotation_detection");
      const { createWorker, OEM } = await import("tesseract.js");
      // Loading chi_sim and chi_tra together makes Tesseract mix the scripts (美团 read as 美團), so
      // each page is read with English + one Chinese model, and re-read with the other only when
      // Chinese text is present; the more confident reading wins.
      const latin = codes.filter((code) => !code.startsWith("chi_"));
      const chinese = codes.filter((code) => code.startsWith("chi_"));
      const sets = chinese.length > 0 ? chinese.map((code) => [...latin, code]) : [latin.length > 0 ? latin : ["eng"]];
      let loaded = sets[0];
      const traditional = new Map<number, OcrPage>();
      const worker = await createWorker(loaded, OEM.LSTM_ONLY, {
        workerPath: assets.workerPath, corePath: assets.corePath, langPath: assets.langPath, workerBlobURL: false, gzip: true,
        cacheMethod: assets.cacheMethod, logger: () => undefined, errorHandler: () => undefined,
      });
      const abort = () => void worker.terminate();
      signal?.addEventListener("abort", abort, { once: true });
      try {
        for (const image of images) {
          if (signal?.aborted) {
            result.errors.push({ page: image.page, code: "cancelled", message: "Cancelled." });
            continue;
          }
          if (image.kind === "heic") {
            result.errors.push({ page: image.page, code: "unsupported_format", message: "HEIC images cannot be decoded by this engine." });
            result.unsupported.push("format:heic");
            continue;
          }
          try {
            result.pages.push(await recognizePage(image));
          } catch {
            result.errors.push({ page: image.page, code: signal?.aborted ? "cancelled" : "recognition_failed", message: "Text recognition failed." });
          }
        }
      } finally {
        signal?.removeEventListener("abort", abort);
        await worker.terminate().catch(() => undefined);
      }
      result.unsupported = [...new Set(result.unsupported)];
      if (traditional.size > 0) {
        // Tesseract cannot tell Simplified from Traditional Chinese reliably: both readings go to the preview.
        result.scriptVariants = { "zh-Hans": result.pages, "zh-Hant": result.pages.map((page) => traditional.get(page.page) ?? page) };
        result.unsupported.push("script_detection:zh");
      }
      return result;

      async function readWith(languagesToLoad: string[], bytes: Uint8Array): Promise<OcrLine[]> {
        if (languagesToLoad.join("+") !== loaded.join("+")) {
          await worker.reinitialize(languagesToLoad.join("+"), OEM.LSTM_ONLY);
          loaded = languagesToLoad;
        }
        const output = await worker.recognize(bytes as never, {}, { blocks: true, text: false, hocr: false, tsv: false });
        return linesOf((output.data as unknown as { blocks: TesseractBlock[] | null }).blocks);
      }

      /** Reading with the first model set, plus the Traditional reading when Chinese text is present. */
      async function read(bytes: Uint8Array): Promise<{ lines: OcrLine[]; traditional: OcrLine[] | null }> {
        const lines = await readWith(sets[0], bytes);
        const traditionalSet = sets.find((set) => set.includes("chi_tra"));
        if (traditionalSet && traditionalSet !== sets[0] && lines.some((line) => CJK.test(line.text))) return { lines, traditional: await readWith(traditionalSet, bytes) };
        return { lines, traditional: null };
      }

      async function recognizePage(image: OcrImage): Promise<OcrPage> {
        const size = imageSize(image.bytes);
        if (!size) throw new Error("undecodable");
        let reading = await read(image.bytes);
        let lines = reading.lines;
        let rotation: OcrPage["rotation"] = 0;
        // A sideways or upside-down page reads poorly: try the other quarter turns and keep the best.
        const confident = lines.length >= 3 && lines.reduce((sum, line) => sum + (line.confidence ?? 0), 0) / lines.length >= 0.75;
        if (!confident && assets.rotate) {
          let best = quality(lines);
          for (const degrees of [90, 180, 270] as const) {
            const candidate = await read(await assets.rotate(image, degrees));
            if (quality(candidate.lines) > best) {
              best = quality(candidate.lines);
              reading = candidate;
              lines = candidate.lines;
              rotation = degrees;
            }
          }
        }
        const swapped = rotation === 90 || rotation === 270;
        const page: OcrPage = { page: image.page, width: swapped ? size.height : size.width, height: swapped ? size.width : size.height, rotation, lines };
        if (reading.traditional) traditional.set(image.page, { ...page, lines: reading.traditional });
        return page;
      }
    },
  };
}
