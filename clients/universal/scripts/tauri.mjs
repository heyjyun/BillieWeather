#!/usr/bin/env node
// Runs the Tauri CLI with the BillieWeather server baked in:
//   BILLIE_API_URL=https://your-app.onrender.com npm run desktop:build
// Defaults to the local Rails server (http://localhost:3000).
// It allows exactly that one origin in the app's Content Security Policy and passes it
// to the frontend as VITE_BILLIE_API_URL. Nothing else in the app may reach the network.
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

export function apiOrigin(value) {
  const url = new URL(value || "http://localhost:3000");
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (url.protocol !== "https:" && !(local && url.protocol === "http:")) {
    throw new Error(`BILLIE_API_URL must be https (or http://localhost for development): ${value}`);
  }
  return url.origin;
}

export function cspWithOrigin(csp, origin) {
  return csp.replace(/connect-src ([^;]+)/, (_match, sources) => `connect-src ${sources.trim()} ${origin}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const origin = apiOrigin(process.env.BILLIE_API_URL);
  const base = JSON.parse(readFileSync(join(root, "src-tauri/tauri.conf.json"), "utf8"));
  const overridePath = join(root, "src-tauri/tauri.api.conf.json");
  writeFileSync(overridePath, JSON.stringify({ app: { security: { csp: cspWithOrigin(base.app.security.csp, origin) } } }, null, 2) + "\n");
  const result = spawnSync("npx", ["tauri", ...process.argv.slice(2), "--config", overridePath], {
    cwd: root,
    stdio: "inherit",
    env: { ...process.env, VITE_BILLIE_API_URL: origin },
  });
  process.exit(result.status ?? 1);
}
