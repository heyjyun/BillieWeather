// Local-first guarantees, checked statically so they cannot quietly regress:
// no network calls, no logging, no cloud credentials, and a WebView CSP that blocks
// outbound connections. Phase 5 (optional AI) must add an explicit, reviewed exception.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(__dirname, "..");
const SOURCES = [join(ROOT, "src"), join(ROOT, "../../packages/finance-core/src"), join(ROOT, "../../packages/reporting/src"), join(ROOT, "../../packages/shared-types/src")];
const RUST = join(ROOT, "src-tauri/src");

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : /\.(ts|tsx|rs)$/.test(name) ? [path] : [];
  });
}
const all = [...SOURCES, RUST].flatMap(files);

describe("data isolation", () => {
  it("found the source files", () => expect(all.length).toBeGreaterThan(10));

  it.each([
    ["fetch(", /\bfetch\s*\(/],
    ["XMLHttpRequest", /XMLHttpRequest/],
    ["WebSocket", /\bWebSocket\b/],
    ["sendBeacon", /sendBeacon/],
    ["EventSource", /\bEventSource\b/],
    ["tauri http plugin", /plugin-http|tauri_plugin_http|reqwest/],
  ])("no network API: %s", (_name, pattern) => {
    expect(all.filter((file) => pattern.test(readFileSync(file, "utf8")))).toEqual([]);
  });

  it("no console logging or Rust print macros (financial data must stay out of logs)", () => {
    const offenders = all.filter((file) => /\bconsole\.(log|info|debug|warn|error|trace)\b|\b(println|eprintln|dbg|log::\w+)!/.test(readFileSync(file, "utf8")));
    expect(offenders).toEqual([]);
  });

  it("no cloud credentials or Neon/Render endpoints", () => {
    const offenders = all.filter((file) => /DATABASE_URL|neon\.tech|postgres(ql)?:\/\/|OPENAI|sk-[A-Za-z0-9]{10,}|onrender\.com|api[_-]?key/i.test(readFileSync(file, "utf8")));
    expect(offenders).toEqual([]);
  });

  it("the app's Content Security Policy only allows the local IPC bridge", () => {
    const config = JSON.parse(readFileSync(join(ROOT, "src-tauri/tauri.conf.json"), "utf8"));
    const csp: string = config.app.security.csp;
    const connect = /connect-src ([^;]+)/.exec(csp)?.[1].trim().split(/\s+/) ?? [];
    expect(connect.sort()).toEqual(["http://ipc.localhost", "ipc:"]);
    expect(csp).toMatch(/default-src 'self'/);
  });

  it("the app requests no network, shell, or broad file-system permissions", () => {
    const capability = JSON.parse(readFileSync(join(ROOT, "src-tauri/capabilities/default.json"), "utf8"));
    const permissions: string[] = capability.permissions.map((p: string | { identifier: string }) => (typeof p === "string" ? p : p.identifier));
    expect(permissions.filter((p) => /^(http|shell|fs:allow-read|fs:scope|fs:default)/.test(p))).toEqual([]);
  });

  it("the local database file and build output are git-ignored", () => {
    const ignore = readFileSync(join(ROOT, ".gitignore"), "utf8");
    for (const pattern of ["*.db", "*.sqlite", "node_modules/", "src-tauri/target/"]) expect(ignore).toContain(pattern);
  });
});
