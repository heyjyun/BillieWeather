#!/usr/bin/env node
// Runs the Tauri CLI with the BillieWeather servers baked in:
//   BILLIE_API_URL=https://your-app.onrender.com BILLIE_IDENTITY_URL=https://your-identity.onrender.com npm run desktop:build
// Defaults to the local Rails server (http://localhost:3000) and the local identity service
// (services/identity-api, http://localhost:8100).
// It allows exactly those two origins in the app's Content Security Policy and passes them to the
// frontend as VITE_BILLIE_API_URL and VITE_BILLIE_IDENTITY_URL. Nothing else may reach the network.
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

export function apiOrigin(value, fallback = "http://localhost:3000", name = "BILLIE_API_URL") {
  const url = new URL(value || fallback);
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (url.protocol !== "https:" && !(local && url.protocol === "http:")) {
    throw new Error(`${name} must be https (or http://localhost for development): ${value}`);
  }
  return url.origin;
}

export function identityOrigin(value) {
  return apiOrigin(value, "http://localhost:8100", "BILLIE_IDENTITY_URL");
}

export function cspWithOrigin(csp, ...origins) {
  const unique = [...new Set(origins)];
  return csp.replace(/connect-src ([^;]+)/, (_match, sources) => `connect-src ${[sources.trim(), ...unique].join(" ")}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const origin = apiOrigin(process.env.BILLIE_API_URL);
  const identity = identityOrigin(process.env.BILLIE_IDENTITY_URL);
  const base = JSON.parse(readFileSync(join(root, "src-tauri/tauri.conf.json"), "utf8"));
  const overridePath = join(root, "src-tauri/tauri.api.conf.json");
  writeFileSync(overridePath, JSON.stringify({ app: { security: { csp: cspWithOrigin(base.app.security.csp, origin, identity) } } }, null, 2) + "\n");
  const result = spawnSync("npx", ["tauri", ...process.argv.slice(2), "--config", overridePath], {
    cwd: root,
    stdio: "inherit",
    env: { ...process.env, VITE_BILLIE_API_URL: origin, VITE_BILLIE_IDENTITY_URL: identity },
  });
  process.exit(result.status ?? 1);
}
