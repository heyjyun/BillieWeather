// The on-device OCR engine for this platform, chosen once at start-up:
// - macOS (Tauri): Apple Vision (native, src-tauri/src/ocr.rs).
// - iOS (Tauri): Apple Vision via the billie-ocr mobile plugin.
// - Android (Tauri): ML Kit Text Recognition v2 (bundled models) via the billie-ocr plugin.
// - Windows / Linux (Tauri) and browsers: Tesseract compiled to WebAssembly, shipped with the app
//   (src/services/ocr/tesseractEngine.ts; assets under /ocr/ from vite.config.ts).
// Only engines that run on the device can be registered; there is no cloud OCR.
import type { OcrEngine, OcrImage } from "@billie/finance-core";
import { isTauri } from "./platform";

let engine: OcrEngine | null = null;

export function ocrEngine(): OcrEngine | null {
  return engine;
}

/** For platform adapters (and tests). Only on-device engines are accepted. */
export function registerOcrEngine(next: OcrEngine | null): void {
  if (next && next.info.location !== "device") throw new Error("Only on-device OCR engines can be registered.");
  engine = next;
}

/** Rotates an image by a quarter turn with a canvas (browsers, WebViews). */
async function rotateWithCanvas(image: OcrImage, degrees: 90 | 180 | 270): Promise<Uint8Array> {
  const bitmap = await createImageBitmap(new Blob([image.bytes as BlobPart], { type: `image/${image.kind}` }));
  const swapped = degrees !== 180;
  const canvas = new OffscreenCanvas(swapped ? bitmap.height : bitmap.width, swapped ? bitmap.width : bitmap.height);
  const context = canvas.getContext("2d")!;
  context.translate(canvas.width / 2, canvas.height / 2);
  context.rotate((degrees * Math.PI) / 180);
  context.drawImage(bitmap, -bitmap.width / 2, -bitmap.height / 2);
  bitmap.close();
  return new Uint8Array(await (await canvas.convertToBlob({ type: "image/png" })).arrayBuffer());
}

/**
 * Browsers only: a service worker keeps the OCR engine files (and nothing else) for offline use.
 * Resolves once the page is controlled, so the first recognition already fills the cache.
 */
export async function enableOfflineOcr(): Promise<boolean> {
  if (isTauri() || typeof navigator === "undefined" || !("serviceWorker" in navigator)) return false;
  try {
    await navigator.serviceWorker.register(new URL("ocr-sw.js", new URL(import.meta.env.BASE_URL ?? "/", window.location.href)).href, { scope: import.meta.env.BASE_URL ?? "/" });
    await navigator.serviceWorker.ready;
    if (!navigator.serviceWorker.controller) {
      await new Promise<void>((resolve) => {
        navigator.serviceWorker.addEventListener("controllerchange", () => resolve(), { once: true });
        setTimeout(resolve, 3000);
      });
    }
    return Boolean(navigator.serviceWorker.controller);
  } catch {
    return false;
  }
}

export async function tesseractForThisApp(): Promise<OcrEngine> {
  void enableOfflineOcr();
  const { tesseractEngine } = await import("./ocr/tesseractEngine");
  const base = new URL("ocr/", new URL(import.meta.env.BASE_URL ?? "/", window.location.href)).href;
  return tesseractEngine({
    workerPath: `${base}worker.min.js`, corePath: `${base}core`, langPath: `${base}lang`,
    // Installed apps bundle the models; browsers keep them via the OCR service worker (enableOfflineOcr).
    cacheMethod: "none",
    rotate: typeof OffscreenCanvas === "undefined" ? undefined : rotateWithCanvas,
  });
}

/** Picks and registers this platform's engine. Never throws: without an engine, OCR imports are refused clearly. */
export async function initOcrEngine(): Promise<OcrEngine | null> {
  try {
    if (isTauri()) {
      const userAgent = navigator.userAgent;
      if (/Android/i.test(userAgent)) {
        const { mobilePluginEngine } = await import("./ocr/nativeEngines");
        registerOcrEngine(mobilePluginEngine("mlkit-text-v2"));
      } else if (/iPhone|iPad|iPod/.test(userAgent) || (/Macintosh/.test(userAgent) && navigator.maxTouchPoints > 1)) {
        const { mobilePluginEngine } = await import("./ocr/nativeEngines");
        registerOcrEngine(mobilePluginEngine("apple-vision"));
      } else {
        const { invoke } = await import("@tauri-apps/api/core");
        const capabilities = await invoke<{ engine: string | null }>("ocr_capabilities");
        if (capabilities.engine === "apple-vision") {
          const { appleVisionDesktopEngine } = await import("./ocr/nativeEngines");
          registerOcrEngine(appleVisionDesktopEngine());
        } else {
          registerOcrEngine(await tesseractForThisApp());
        }
      }
    } else if (typeof window !== "undefined" && typeof Worker !== "undefined") {
      registerOcrEngine(await tesseractForThisApp());
    }
  } catch {
    registerOcrEngine(null);
  }
  return engine;
}
