/// <reference types="vitest/config" />
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const packages = fileURLToPath(new URL("../../packages", import.meta.url));
const host = process.env.TAURI_DEV_HOST;

// The shared packages are plain TypeScript source, resolved by alias (no build step).
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@billie/shared-types": `${packages}/shared-types/src/index.ts`,
      "@billie/finance-core": `${packages}/finance-core/src/index.ts`,
      "@billie/reporting": `${packages}/reporting/src/index.ts`,
    },
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
