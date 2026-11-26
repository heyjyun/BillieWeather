#!/usr/bin/env node
// Runs the Tauri CLI with the BillieWeather servers baked in:
//   BILLIE_API_URL=https://your-app.onrender.com BILLIE_IDENTITY_URL=https://your-identity.onrender.com npm run desktop:build
// `dev` defaults to the local Rails server (http://localhost:3000) and the local identity service
// (services/identity-api, http://localhost:8100). `build` refuses those defaults: an installed app
// that silently depends on development servers on this computer fails with "Can't reach
// BillieWeather" as soon as they stop. Set both URLs, or BILLIE_ALLOW_LOCAL_SERVERS=1 to build a
// local-only development app on purpose.
// It allows exactly those two origins in the app's Content Security Policy and passes them to the
// frontend as VITE_BILLIE_API_URL and VITE_BILLIE_IDENTITY_URL. Nothing else may reach the network.
// `dev` and BILLIE_VARIANT=dev builds run as com.billieweather.client.dev with their own data folder; the app refuses to start as a
// debug build of the shipped app (src-tauri/src/variant.rs). QA builds: scripts/qa.mjs.
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

const isLocal = (origin) => /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);

/** Which app a build is: "stable" (the shipped identifier) or "dev" (BillieWeather Dev.app). */
export function buildVariant(value, command) {
  if (command === "dev") return "dev";
  const variant = (value || "stable").trim();
  if (variant !== "stable" && variant !== "dev") throw new Error(`BILLIE_VARIANT must be "stable" or "dev": ${value}`);
  return variant;
}

/**
 * The Dev app talks only to the development servers on this computer (and through them to the Neon
 * Development project). Pointing it at a hosted server would sign test accounts into production.
 */
export function assertVariantOrigins(variant, origins) {
  if (variant !== "dev") return;
  const remote = Object.entries(origins).filter(([, origin]) => !isLocal(origin));
  if (!remote.length) return;
  throw new Error(
    `Refusing to build BillieWeather Dev against a non-local server:\n` +
    remote.map(([name, origin]) => `  ${name} → ${origin}`).join("\n") +
    `\nThe Dev app uses http://localhost:3000 and http://localhost:8100 only (Neon development).`,
  );
}

/** Throws when a release build would bake in a localhost server without an explicit opt-in. */
export function assertReleaseOrigins(command, origins, allowLocal = false) {
  if (command !== "build" || allowLocal) return;
  const local = Object.entries(origins).filter(([, origin]) => isLocal(origin));
  if (!local.length) return;
  throw new Error(
    `Refusing to build a desktop app that depends on development servers on this computer:\n` +
    local.map(([name, origin]) => `  ${name} → ${origin}`).join("\n") +
    `\nSet BILLIE_API_URL and BILLIE_IDENTITY_URL to the deployed https servers, or set ` +
    `BILLIE_ALLOW_LOCAL_SERVERS=1 to build a local-development app on purpose.`,
  );
}

export function cspWithOrigin(csp, ...origins) {
  const unique = [...new Set(origins)];
  return csp.replace(/connect-src ([^;]+)/, (_match, sources) => `connect-src ${[sources.trim(), ...unique].join(" ")}`);
}

/** The build number of a commit (CFBundleVersion): counts up with every commit, the same for everyone. */
export function buildNumber(count) {
  if (!/^[1-9][0-9]{0,8}$/.test(String(count))) throw new Error("No build number: not a git checkout with history");
  return String(count);
}
export const commitCount = (cwd) => buildNumber(spawnSync("git", ["rev-list", "--count", "HEAD"], { cwd, encoding: "utf8" }).stdout?.trim());
/** Release builds carry the commit's build number; `dev` keeps the version. */
export const bundleVersion = (number) => ({ macOS: { bundleVersion: number } });

/**
 * `dev`, and a `build` with BILLIE_VARIANT=dev (the installed "BillieWeather Dev.app"), never share the
 * shipped app's identity, and with it the real ledgers, keychain entry, WebView storage and sign-in.
 */
export function developmentIdentity(command, variant) {
  if (command !== "dev" && variant !== "dev") return {};
  return { identifier: "com.billieweather.client.dev", productName: "BillieWeather Dev", plugins: { "deep-link": { desktop: { schemes: ["billieweather-dev"] }, mobile: [{ scheme: ["billieweather-dev"], appLink: false }] } } };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const origin = apiOrigin(process.env.BILLIE_API_URL);
  const identity = identityOrigin(process.env.BILLIE_IDENTITY_URL);
  let variant;
  try {
    variant = buildVariant(process.env.BILLIE_VARIANT, process.argv[2]);
    const origins = { BILLIE_API_URL: origin, BILLIE_IDENTITY_URL: identity };
    assertVariantOrigins(variant, origins);
    assertReleaseOrigins(process.argv[2], origins, variant === "dev" || process.env.BILLIE_ALLOW_LOCAL_SERVERS === "1");
  } catch (error) {
    console.error(`\n${error.message}\n`);
    process.exit(1);
  }
  console.log(`BillieWeather${variant === "dev" ? " Dev" : ""} servers for this ${process.argv[2] ?? "run"}: API ${origin}, identity ${identity}`);
  const base = JSON.parse(readFileSync(join(root, "src-tauri/tauri.conf.json"), "utf8"));
  const overridePath = join(root, "src-tauri/tauri.api.conf.json");
  writeFileSync(overridePath, JSON.stringify({ ...developmentIdentity(process.argv[2], variant), ...(process.argv[2] === "build" ? { bundle: bundleVersion(commitCount(root)) } : {}), app: { ...(developmentIdentity(process.argv[2], variant).identifier ? { windows: base.app.windows.map((window) => ({ ...window, title: "BillieWeather Dev" })) } : {}), security: { csp: cspWithOrigin(base.app.security.csp, origin, identity) } } }, null, 2) + "\n");
  const result = spawnSync("npx", ["tauri", ...process.argv.slice(2), "--config", overridePath], {
    cwd: root,
    stdio: "inherit",
    env: { ...process.env, VITE_BILLIE_API_URL: origin, VITE_BILLIE_IDENTITY_URL: identity },
  });
  process.exit(result.status ?? 1);
}
