// Native on-device OCR engines reached through Tauri:
// - macOS: Apple Vision, command `ocr_recognize_image` (src-tauri/src/ocr.rs), raw image bytes.
// - iOS (Apple Vision) / Android (ML Kit, bundled models): plugin `billie-ocr`
//   (src-tauri/plugins/billie-ocr), base64 image because mobile plugin arguments are JSON.
// Both return the shared OcrResult contract; nothing is sent over the network.
import { mergeOcrResults, OCR_LANGUAGES, parseOcrResult, type OcrEngine, type OcrImage, type OcrResult } from "@billie/finance-core";

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
      results.push({ engine, languages: [], pages: [], errors: [{ page: image.page, code: "recognition_failed", message: "Text recognition failed." }], unsupported: [] });
    }
  }
  const merged = mergeOcrResults(results);
  // Per-page results report the engine they ran; keep it if any page succeeded.
  return { ...merged, engine: results.find((result) => result.engine.id !== "unknown")?.engine ?? engine };
}

export function appleVisionDesktopEngine(): OcrEngine {
  return {
    info: { id: "apple-vision", location: "device", languages: [...OCR_LANGUAGES] },
    async recognize({ images, languages, signal }) {
      const { invoke } = await import("@tauri-apps/api/core");
      const codes = languages.map((language) => VISION_LANGUAGES[language] ?? language).join(",");
      return each(images, signal, async (image) => parseOcrResult(await invoke("ocr_recognize_image", image.bytes, {
        headers: { "x-ocr-languages": codes, "x-ocr-page": String(image.page) },
      })), { id: "apple-vision", version: "unknown" });
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
