// Native on-device OCR engines reached through Tauri:
// - macOS: Apple Vision, command `ocr_recognize_image` (src-tauri/src/ocr.rs), raw image bytes.
// - iOS (Apple Vision) / Android (ML Kit, bundled models): plugin `billie-ocr`
//   (src-tauri/plugins/billie-ocr), base64 image because mobile plugin arguments are JSON.
// Both return the shared OcrResult contract; nothing is sent over the network.
import { mergeOcrResults, OCR_LANGUAGES, parseOcrResult, type OcrEngine, type OcrImage, type OcrResult } from "@billie/finance-core";

import { randomId } from "../ids";

const VISION_LANGUAGES: Record<string, string> = { en: "en-US", "zh-Hans": "zh-Hans", "zh-Hant": "zh-Hant" };

async function each(images: OcrImage[], signal: AbortSignal | undefined, read: (image: OcrImage) => Promise<OcrResult>, engine: OcrResult["engine"]): Promise<OcrResult> {
  const results: OcrResult[] = [];
  for (const image of images) {
    if (signal?.aborted) {
      results.push({ engine, languages: [], pages: [], errors: [{ page: image.page, code: "cancelled", message: "Cancelled." }], unsupported: [] });
      continue;
    }
    try {
      results.push(await read(image));
    } catch {
      results.push({ engine, languages: [], pages: [], errors: [{ page: image.page, code: signal?.aborted ? "cancelled" : "recognition_failed", message: signal?.aborted ? "Cancelled." : "Text recognition failed." }], unsupported: [] });
    }
  }
  const merged = mergeOcrResults(results);
  // Per-page results report the engine they ran; keep it if any page succeeded.
  return { ...merged, engine: results.find((result) => result.engine.id !== "unknown")?.engine ?? engine };
}

// Some native requests can take longer than a user can reasonably wait. Release the
// review UI on cancellation/deadline and ignore an IPC response that arrives afterward.
class DesktopOcrTimeout extends Error {}

function waitForDesktopOcr<T>(response: Promise<T>, cancel: () => void, signal?: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const finish = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    };
    const abort = () => { finish(); cancel(); reject(new Error("OCR cancelled")); };
    const timer = setTimeout(() => { finish(); cancel(); reject(new DesktopOcrTimeout("OCR timed out")); }, 20_000);
    signal?.addEventListener("abort", abort, { once: true });
    response.then((result) => { finish(); resolve(result); }, (error: unknown) => { finish(); reject(error); });
    if (signal?.aborted) abort();
  });
}

export function appleVisionDesktopEngine(fallback?: () => Promise<OcrEngine>): OcrEngine {
  return {
    info: { id: "apple-vision", location: "device", languages: [...OCR_LANGUAGES] },
    async recognize(input) {
      const { images, languages, signal } = input;
      const { invoke } = await import("@tauri-apps/api/core");
      const codes = languages.map((language) => VISION_LANGUAGES[language] ?? language).join(",");
      let timedOut = false;
      const result = await each(images, signal, async (image) => {
        if (timedOut) throw new DesktopOcrTimeout("OCR timed out");
        const job = randomId();
        const cancel = () => { void invoke("ocr_cancel_image", { job }).catch(() => {}); };
        try {
          const response = invoke("ocr_recognize_image", image.bytes, {
            headers: { "x-ocr-languages": codes, "x-ocr-page": String(image.page), "x-ocr-job-id": job },
          });
          return parseOcrResult(await waitForDesktopOcr(response, cancel, signal));
        } catch (error) {
          // "ocr_preparing": the models are still being prepared on this Mac (first use). That
          // goes on in the background; this batch is read by the fallback engine instead.
          timedOut = error === "ocr_timeout" || error === "ocr_preparing" || error instanceof DesktopOcrTimeout;
          throw error;
        }
      }, { id: "apple-vision", version: "unknown" });
      if (!fallback || signal?.aborted ||
          (!timedOut && (result.pages.length || !result.errors.some((error) => error.code === "recognition_failed")))) return result;
      const engine = await fallback();
      if (engine.info.location !== "device") return result;
      return engine.recognize(input);
    },
  };
}

function base64(bytes: Uint8Array): string {
  let binary = "";
  for (let start = 0; start < bytes.length; start += 0x8000) binary += String.fromCharCode(...bytes.subarray(start, start + 0x8000));
  return btoa(binary);
}

export function mobilePluginEngine(id: "apple-vision" | "mlkit-text-v2"): OcrEngine {
  return {
    info: { id, location: "device", languages: [...OCR_LANGUAGES] },
    async recognize({ images, languages, signal }) {
      const { invoke } = await import("@tauri-apps/api/core");
      const codes = id === "apple-vision" ? languages.map((language) => VISION_LANGUAGES[language] ?? language) : languages;
      return each(images, signal, async (image) => parseOcrResult(await invoke("plugin:billie-ocr|recognize", { image: base64(image.bytes), page: image.page, languages: codes })),
        { id, version: "unknown" });
    },
  };
}
