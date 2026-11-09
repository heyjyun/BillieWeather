// Local-first guarantees, checked statically so they cannot quietly regress:
// financial code never touches the network, nothing is logged, no cloud credentials,
// and the WebView CSP allows only the BillieWeather account server.
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

  // The account service is the single, reviewed exception: it talks to the BillieWeather
  // account API. Everything else, including all financial code, must stay offline.
  const ACCOUNT = join(ROOT, "src/services/account.ts");

  it.each([
    ["fetch(", /\bfetch\s*\(/],
    ["XMLHttpRequest", /XMLHttpRequest/],
    ["WebSocket", /\bWebSocket\b/],
    ["sendBeacon", /sendBeacon/],
    ["EventSource", /\bEventSource\b/],
    ["tauri http plugin", /plugin-http|tauri_plugin_http|reqwest/],
  ])("no network API outside the account service: %s", (_name, pattern) => {
    expect(all.filter((file) => file !== ACCOUNT && pattern.test(readFileSync(file, "utf8")))).toEqual([]);
  });

  it("the account service cannot see financial data: it imports nothing", () => {
    const source = readFileSync(ACCOUNT, "utf8");
    expect(source.match(/^import .*$/gm) ?? []).toEqual([]);
    expect(source).not.toMatch(/@billie\/|\bFinanceStore\b|\bTransaction\b|\bStatement\b|amountCents|merchantKey/);
    // Only the account endpoints are ever called.
    expect([...source.matchAll(/request<[^>]*>\("([^"]+)"/g)].map((match) => match[1]).sort()).toEqual(["/account", "/account", "/session", "/session"]);
  });

  it("only the account service touches the account API base URL", () => {
    expect(all.filter((file) => file !== ACCOUNT && /api\/client\/v1/.test(readFileSync(file, "utf8")))).toEqual([]);
  });

  it("no console logging or Rust print macros (financial data must stay out of logs)", () => {
    const offenders = all.filter((file) => /\bconsole\.(log|info|debug|warn|error|trace)\b|\b(println|eprintln|dbg|log::\w+)!/.test(readFileSync(file, "utf8")));
    expect(offenders).toEqual([]);
  });

  it("no cloud credentials or Neon/Render endpoints", () => {
    const offenders = all.filter((file) => /DATABASE_URL|neon\.tech|postgres(ql)?:\/\/|OPENAI|sk-[A-Za-z0-9]{10,}|onrender\.com|api[_-]?key/i.test(readFileSync(file, "utf8")));
    expect(offenders).toEqual([]);
  });

  it("the base Content Security Policy allows only the local IPC bridge", () => {
    const config = JSON.parse(readFileSync(join(ROOT, "src-tauri/tauri.conf.json"), "utf8"));
    const csp: string = config.app.security.csp;
    expect((/connect-src ([^;]+)/.exec(csp)?.[1].trim().split(/\s+/) ?? []).sort()).toEqual(["http://ipc.localhost", "ipc:"]);
    expect(csp).toMatch(/default-src 'self'/);
  });

  it("builds add exactly one origin — the BillieWeather server — and only over https", async () => {
    // @ts-expect-error plain JS build script
    const { apiOrigin, cspWithOrigin } = await import("../scripts/tauri.mjs");
    const config = JSON.parse(readFileSync(join(ROOT, "src-tauri/tauri.conf.json"), "utf8"));
    const csp = cspWithOrigin(config.app.security.csp, apiOrigin("https://billieweather.example.com/some/path"));
    expect((/connect-src ([^;]+)/.exec(csp)?.[1].trim().split(/\s+/) ?? []).sort()).toEqual(["http://ipc.localhost", "https://billieweather.example.com", "ipc:"]);
    expect(apiOrigin(undefined)).toBe("http://localhost:3000");
    expect(() => apiOrigin("http://billieweather.example.com")).toThrow(/https/);
  });

  it("the app requests no network, shell, or broad file-system permissions", () => {
    const capability = JSON.parse(readFileSync(join(ROOT, "src-tauri/capabilities/default.json"), "utf8"));
    const permissions: string[] = capability.permissions.map((p: string | { identifier: string }) => (typeof p === "string" ? p : p.identifier));
    expect(permissions.filter((p) => /^(http|shell|fs:allow-read|fs:scope|fs:default|opener:default)/.test(p))).toEqual([]);
  });

  it("the local database file and build output are git-ignored", () => {
    const ignore = readFileSync(join(ROOT, ".gitignore"), "utf8");
    for (const pattern of ["*.db", "*.sqlite", "node_modules/", "src-tauri/target/"]) expect(ignore).toContain(pattern);
  });
});
