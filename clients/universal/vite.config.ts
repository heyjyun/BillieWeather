/// <reference types="vitest/config" />
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

const modules = fileURLToPath(new URL("./node_modules", import.meta.url));

/**
 * On-device OCR assets, served from the app's own origin under /ocr/ (dev server) and copied into
 * the build: the tesseract.js worker, the LSTM WASM cores (one is picked by SIMD support; the WASM
 * is embedded, so nothing else is fetched) and the eng / chi_sim / chi_tra models. All Apache-2.0
 * (tesseract.js, tesseract.js-core) / MIT (@tesseract.js-data packaging of Apache-2.0 tessdata).
 */
export const OCR_ASSETS: Record<string, string> = {
  "ocr/worker.min.js": `${modules}/tesseract.js/dist/worker.min.js`,
  ...Object.fromEntries(["lstm", "simd-lstm", "relaxedsimd-lstm"].map((variant) => [`ocr/core/tesseract-core-${variant}.wasm.js`, `${modules}/tesseract.js-core/tesseract-core-${variant}.wasm.js`])),
  ...Object.fromEntries(["eng", "chi_sim", "chi_tra"].map((lang) => [`ocr/lang/${lang}.traineddata.gz`, `${modules}/@tesseract.js-data/${lang}/4.0.0_best_int/${lang}.traineddata.gz`])),
};

/**
 * Tauri builds for Apple platforms and Android always use the native engine (Apple Vision, ML Kit;
 * see src/services/ocrEngine.ts and src-tauri/src/ocr.rs), so Tesseract is never loaded there and
 * its ~10 MB is left out. Browsers, Windows and Linux keep it.
 */
export function needsTesseract(tauriPlatform: string | undefined): boolean {
  return !["darwin", "macos", "ios", "android"].includes(tauriPlatform ?? "");
}

function ocrAssets(): Plugin {
  return {
    name: "billie-ocr-assets",
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const path = OCR_ASSETS[(request.url ?? "").split("?")[0].replace(/^\//, "")];
        if (!path) return next();
        response.setHeader("Content-Type", path.endsWith(".js") ? "text/javascript" : "application/octet-stream");
        response.end(readFileSync(path));
      });
    },
    generateBundle() {
      if (!needsTesseract(process.env.TAURI_ENV_PLATFORM)) return;
      for (const [fileName, path] of Object.entries(OCR_ASSETS)) this.emitFile({ type: "asset", fileName, source: readFileSync(path) });
    },
  };
}

const packages = fileURLToPath(new URL("../../packages", import.meta.url));
const host = process.env.TAURI_DEV_HOST;

// The shared packages are plain TypeScript source, resolved by alias (no build step).
export default defineConfig({
  plugins: [react(), ocrAssets()],
  resolve: {
    alias: {
      "@billie/shared-types": `${packages}/shared-types/src/index.ts`,
      "@billie/finance-core": `${packages}/finance-core/src/index.ts`,
      "@billie/reporting": `${packages}/reporting/src/index.ts`,
      "@billie/design-tokens": `${packages}/design-tokens/src/tokens.ts`,
      "@nlae/core": `${packages}/nl-action-engine/src/index.ts`,
      "@nlae/react/commandBar.css": `${packages}/nl-action-react/src/commandBar.css`,
      "@nlae/react": `${packages}/nl-action-react/src/index.ts`,
    },
    // packages/nl-action-react imports React from outside this folder; always use this app's copy.
    dedupe: ["react", "react-dom"],
  },
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host ? { protocol: "ws", host, port: 1421 } : undefined,
    fs: { allow: [".", packages] },
    watch: { ignored: ["**/src-tauri/**"] },
  },
  envPrefix: ["VITE_", "TAURI_ENV_*"],
  build: {
    target: process.env.TAURI_ENV_PLATFORM === "windows" ? "chrome105" : "safari15",
    minify: process.env.TAURI_ENV_DEBUG ? false : "esbuild",
    sourcemap: Boolean(process.env.TAURI_ENV_DEBUG),
  },
  test: {
    globals: true,
    environment: "node",
    include: ["test/**/*.test.{ts,tsx}", "../../packages/*/test/**/*.test.ts"],
    root: fileURLToPath(new URL(".", import.meta.url)),
  },
});
