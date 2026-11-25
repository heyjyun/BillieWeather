#!/usr/bin/env node
// Isolated QA builds of the macOS app. Nothing here can build, open or launch the shipped app.
//   node scripts/qa.mjs build [suffix]          release build from a clean commit, then preflight
//   node scripts/qa.mjs preflight <QA.app>      every isolation check, without opening the app
//   node scripts/qa.mjs launch <QA.app>         preflight, open in the background, check its open files
//   node scripts/qa.mjs stop <QA.app>
// Servers: BILLIE_QA_API_URL and BILLIE_QA_IDENTITY_URL (http://127.0.0.1:<port>, never a development port).
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { cspWithOrigin } from "./tauri.mjs";

export const PRODUCTION = { identifier: "com.billieweather.client", name: "BillieWeather", scheme: "billieweather" };
export const QA_IDENTIFIER = /^com\.billieweather\.client\.qa(\.[a-z0-9]{1,20})?$/;
const DEVELOPMENT_PORTS = [1420, 3000, 8100];
const MARKER = "billie-launch-guard-version1";
const root = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Loopback only, on a port no development server uses. */
export function qaOrigin(value, name) {
  let url;
  try { url = new URL(value ?? ""); } catch { throw new Error(`${name} must be set for a QA build`); }
  const port = Number(url.port);
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !port || DEVELOPMENT_PORTS.includes(port) || url.username || url.pathname !== "/") {
    throw new Error(`${name} must be http://127.0.0.1:<port> on an isolated port`);
  }
  return url.origin;
}

/** The Tauri configuration of a QA build: its own identity everywhere the shipped app's appears. */
export function qaConfig(base, suffix, api, identity) {
  const identifier = `${PRODUCTION.identifier}.qa${suffix ? `.${suffix}` : ""}`;
  if (!QA_IDENTIFIER.test(identifier)) throw new Error(`Not a QA suffix: ${suffix}`);
  const name = `BillieWeather QA${suffix ? ` ${suffix}` : ""}`;
  const scheme = `billieweather-qa${suffix ? `-${suffix}` : ""}`;
  return {
    productName: name,
    identifier,
    build: { devUrl: null },
    app: {
      windows: base.app.windows.map((window) => ({ ...window, title: name })),
      security: { csp: cspWithOrigin(base.app.security.csp, api, identity) },
    },
    plugins: { "deep-link": { desktop: { schemes: [scheme] }, mobile: [{ scheme: [scheme], appLink: false }] } },
  };
}

/**
 * Every problem with a bundle, from its Info.plist, its signature and its own `--billie-identity`
 * report. An empty list is the only result that allows a launch.
 */
export function problems({ app, plist, signed, report, home }) {
  const found = [];
  const need = (ok, text) => { if (!ok) found.push(text); };
  const id = plist?.CFBundleIdentifier;
  need(QA_IDENTIFIER.test(id ?? ""), "Info.plist identifier is not a QA identifier");
  need(!["/Applications/", join(home, "Applications") + sep].some((dir) => app.startsWith(dir)), "the bundle is in an Applications folder");
  for (const key of ["CFBundleName", "CFBundleDisplayName"]) {
    need(key === "CFBundleDisplayName" && plist?.[key] === undefined || /\bQA\b/.test(plist?.[key] ?? ""), `${key} is not a QA name`);
  }
  const schemes = (plist?.CFBundleURLTypes ?? []).flatMap((type) => type.CFBundleURLSchemes ?? []);
  need(schemes.every((scheme) => scheme.startsWith("billieweather-qa")), "a URL scheme of the shipped app is registered");
  need(signed?.valid === true, "the signature does not verify");
  need(signed?.identifier === id, "the signed identifier differs from Info.plist");
  if (!report) return [...found, "the binary has no launch guard or gave no identity report"];
  need(report.marker === MARKER, "unknown launch guard version");
  need(report.identifier === id, "the identifier compiled into the binary differs from Info.plist");
  need(report.bundleIdentifier === id, "the running bundle identifier differs from Info.plist");
  need(report.refusal === null, `the binary refuses to start: ${report.refusal}`);
  need(report.debug === false && report.devUrl === null, "debug build or development server");
  need(/\bQA\b/.test(report.productName ?? "") && (report.windowTitles ?? []).length > 0 && report.windowTitles.every((title) => /\bQA\b/.test(title)), "product or window name is not a QA name");
  need(report.keychainService === id, "keychain service is not this QA build's");
  need(/^[0-9a-f]{40}$/.test(report.sourceRevision ?? ""), "no source revision is recorded");
  const own = { dataDir: ["Application Support", id], cacheDir: ["Caches", id], webkitDir: ["WebKit", id], preferences: ["Preferences", `${id}.plist`] };
  for (const [key, parts] of Object.entries(own)) need(report[key] === join(home, "Library", ...parts), `${key} is not this QA build's own`);
  const origins = (report.connect ?? ["*"]).filter((source) => !["'self'", "ipc:", "http://ipc.localhost"].includes(source));
  need(origins.length > 0 && origins.length <= 2 && origins.every((origin) => { try { return qaOrigin(origin, "endpoint") === origin; } catch { return false; } }), "a backend endpoint is not an isolated loopback server");
  return found;
}

/** Paths of the shipped app a QA process must never hold open. */
export function productionFiles(paths, home) {
  const folders = ["Application Support", "Caches", "WebKit", "HTTPStorages", "Preferences", "Saved Application State"]
    .map((folder) => join(home, "Library", folder, PRODUCTION.identifier));
  return paths.filter((path) => folders.some((folder) => path === folder || path.startsWith(`${folder}/`) || path === `${folder}.plist` || path === `${folder}.savedState` || path.startsWith(`${folder}.savedState/`)));
}

const run = (command, args, options = {}) => spawnSync(command, args, { encoding: "utf8", ...options });
const executable = (app) => join(app, "Contents/MacOS/billieweather");

function inspect(path) {
  const app = resolve(path);
  if (!existsSync(app) || lstatSync(app).isSymbolicLink() || realpathSync(app) !== app || !app.endsWith(".app")) throw new Error("Give the real path of a QA .app bundle");
  const plist = JSON.parse(run("plutil", ["-convert", "json", "-o", "-", join(app, "Contents/Info.plist")]).stdout || "null");
  const details = run("codesign", ["-dv", "--verbose=2", app]).stderr ?? "";
  const signed = { valid: run("codesign", ["--verify", "--deep", "--strict", app]).status === 0, identifier: /^Identifier=(.*)$/m.exec(details)?.[1], authority: /^Signature=(.*)$/m.exec(details)?.[1] ?? "certificate" };
  const home = homedir();
  let report = null;
  // Run the binary only when the files on disk already say QA and the guard is compiled in, and even
  // then without network, writes, or the shipped app's folders (sandbox-exec).
  const binary = executable(app);
  if (QA_IDENTIFIER.test(plist?.CFBundleIdentifier ?? "") && signed.valid && existsSync(binary) && !lstatSync(binary).isSymbolicLink() && readFileSync(binary).includes(MARKER)) {
    const closed = ["Application Support", "Caches", "WebKit", "Preferences"].map((folder) => `(deny file-read* (subpath ${JSON.stringify(join(home, "Library", folder, PRODUCTION.identifier))}))`).join("");
    const result = run("/usr/bin/sandbox-exec", ["-p", `(version 1)(allow default)(deny network*)(deny file-write*)${closed}`, binary, "--billie-identity"], { timeout: 10_000, env: { HOME: home, PATH: "/usr/bin:/bin" } });
    try { report = result.status === 0 ? JSON.parse(result.stdout) : null; } catch { report = null; }
  }
  return { app, plist, signed, report, home };
}

function preflight(path) {
  const facts = inspect(path);
  const found = problems(facts);
  console.log(JSON.stringify({ app: basename(facts.app), infoPlist: facts.plist?.CFBundleIdentifier, signed: facts.signed, report: facts.report }, null, 2).replaceAll(facts.home, "~"));
  if (found.length) {
    console.error(`PREFLIGHT FAILED\n${found.map((text) => `  - ${text}`).join("\n")}`);
    process.exit(1);
  }
  console.log("PREFLIGHT PASSED");
  return facts;
}

function pids(app) {
  return (run("ps", ["-axo", "pid=,comm="]).stdout ?? "").split("\n").map((line) => /^\s*(\d+)\s+(.*)$/.exec(line)).filter((m) => m && m[2] === executable(app)).map((m) => Number(m[1]));
}

function stop(app) {
  for (const pid of pids(app)) try { process.kill(pid, "SIGTERM"); } catch { /* already gone */ }
}

function launch(path) {
  const { app, home } = preflight(path);
  if (pids(app).length) throw new Error("This QA app is already running");
  // -g: never bring it to the front.
  if (run("open", ["-g", app]).status !== 0) throw new Error("The QA app did not open");
  const deadline = Date.now() + 8_000;
  let running = [];
  while (Date.now() < deadline) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
    running = pids(app);
    if (!running.length) continue;
    const open = (run("lsof", ["-nP", "-Fn", "-p", running.join(",")]).stdout ?? "").split("\n").filter((line) => line.startsWith("n/")).map((line) => line.slice(1));
    const wrong = productionFiles(open, home);
    if (wrong.length) {
      stop(app);
      throw new Error(`Stopped: the QA app opened ${wrong.length} file(s) of the shipped app`);
    }
  }
  if (!running.length) throw new Error("The QA app is not running");
  console.log(`LAUNCHED pid ${running.join(",")}; no file of the shipped app is open`);
}

function build(suffix) {
  const api = qaOrigin(process.env.BILLIE_QA_API_URL, "BILLIE_QA_API_URL");
  const identity = qaOrigin(process.env.BILLIE_QA_IDENTITY_URL, "BILLIE_QA_IDENTITY_URL");
  const git = (...args) => run("git", args, { cwd: root }).stdout.trim();
  if (git("status", "--porcelain")) throw new Error("Build a QA candidate only from a clean commit");
  const revision = git("rev-parse", "HEAD");
  const config = qaConfig(JSON.parse(readFileSync(join(root, "src-tauri/tauri.conf.json"), "utf8")), suffix, api, identity);
  const dir = mkdtempSync(join(tmpdir(), "billie-qa-"));
  try {
    const file = join(dir, "qa.json");
    writeFileSync(file, JSON.stringify(config));
    const target = process.env.CARGO_TARGET_DIR;
    if (!target) throw new Error("Set CARGO_TARGET_DIR to a QA-only folder");
    const result = spawnSync("npx", ["tauri", "build", "--bundles", "app", "--config", file], { cwd: root, stdio: "inherit", env: { ...process.env, VITE_BILLIE_API_URL: api, VITE_BILLIE_IDENTITY_URL: identity, BILLIE_SOURCE_REVISION: revision } });
    if (result.status !== 0) process.exit(result.status ?? 1);
    const app = realpathSync(join(target, "release/bundle/macos", `${config.productName}.app`));
    // Ad hoc, so the bundle has a signature of its own to check, with the hardened runtime of a release.
    // Never a release signature.
    if (run("codesign", ["--force", "--sign", "-", "--options", "runtime", "--identifier", config.identifier, app]).status !== 0) throw new Error("Signing failed");
    preflight(app);
    console.log(app);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) {
  const [command, argument] = process.argv.slice(2);
  try {
    if (command === "build") build(argument ?? "");
    else if (command === "preflight" && argument) preflight(argument);
    else if (command === "launch" && argument) launch(argument);
    else if (command === "stop" && argument) stop(resolve(argument));
    else throw new Error("Usage: node scripts/qa.mjs build [suffix] | preflight <app> | launch <app> | stop <app>");
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
