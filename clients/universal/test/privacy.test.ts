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

  // Six reviewed exceptions may use the network, all only with the BillieWeather server:
  // account.ts (sign-in and preferences, no financial code) and webSync.ts (read-only
  // download of the person's website data: GET only, never a request body).
  const ACCOUNT = join(ROOT, "src/services/account.ts");
  const WEB_SYNC = join(ROOT, "src/services/webSync.ts");
  // cloudData.ts: what is in the cloud (counts, size, statement list) and deleting one statement at a time.
  const CLOUD = join(ROOT, "src/services/cloudData.ts");
  // cloudManage.ts: rename the cloud database, or delete it after the typed confirmation (no statements).
  // cloudUpload.ts: the only code that sends statements, one per request, when the person starts a transfer to the cloud.
  const MANAGE = join(ROOT, "src/services/cloudManage.ts");
  const UPLOAD = join(ROOT, "src/services/cloudUpload.ts");
  // localReport.ts: one-way metadata about local databases (names, sizes, counts) for the website's cards.
  const REPORT = join(ROOT, "src/services/localReport.ts");
  // aiCategorize.ts: "Categorize with AI", after the consent panel: cleaned merchant text, direction and category names only.
  const AI = join(ROOT, "src/services/aiCategorize.ts");
  const NETWORK_FILES = [ACCOUNT, WEB_SYNC, CLOUD, MANAGE, UPLOAD, REPORT, AI];

  it.each([
    ["fetch(", /\bfetch\s*\(/],
    ["XMLHttpRequest", /XMLHttpRequest/],
    ["WebSocket", /\bWebSocket\b/],
    ["sendBeacon", /sendBeacon/],
    ["EventSource", /\bEventSource\b/],
    ["tauri http plugin", /plugin-http|tauri_plugin_http|reqwest/],
  ])("no network API outside the reviewed services: %s", (_name, pattern) => {
    expect(all.filter((file) => !NETWORK_FILES.includes(file) && pattern.test(readFileSync(file, "utf8")))).toEqual([]);
  });

  it("the website download can only read: GET requests, no body, finance endpoints only", () => {
    const source = readFileSync(WEB_SYNC, "utf8");
    expect([...source.matchAll(/method:\s*"(\w+)"/g)].map((match) => match[1])).toEqual(["GET"]);
    expect(source).not.toMatch(/\bbody\s*:/);
    expect(source).not.toMatch(/\b(POST|PATCH|PUT|DELETE)\b/);
    expect(source).toMatch(/const FINANCE = `\$\{API_ORIGIN\}\/api\/client\/v1\/finance`/);
    expect(source.match(/fetch\(/g)?.length).toBe(1);
  });

  it("the account service cannot see financial data: it imports nothing", () => {
    const source = readFileSync(ACCOUNT, "utf8");
    expect(source.match(/^import .*$/gm) ?? []).toEqual([]);
    expect(source).not.toMatch(/@billie\/|\bFinanceStore\b|\bTransaction\b|\bStatement\b|amountCents|merchantKey/);
    // Only the account endpoints are ever called.
    expect([...source.matchAll(/request<[^>]*>\("([^"]+)"/g)].map((match) => match[1]).sort()).toEqual(["/account", "/account", "/session", "/session"]);
  });

  it("the cloud-data service sends no request body, sees no financial code, and deletes only one statement", () => {
    const source = readFileSync(CLOUD, "utf8");
    expect(source.match(/^import .*$/gm)).toEqual(['import { API_ORIGIN, AccountError } from "./account";']);
    expect(source).not.toMatch(/@billie\/|\bFinanceStore\b|amountCents|merchantKey/);
    expect(source).not.toMatch(/\bbody\s*:|JSON\.stringify/);
    expect(source).toMatch(/const FINANCE = `\$\{API_ORIGIN\}\/api\/client\/v1\/finance`/);
    // The only DELETE targets a single statement id.
    expect([...source.matchAll(/call\((`[^`]*`|"[^"]*"),\s*"DELETE"/g)].map((match) => match[1])).toEqual(["`/statements/${Math.trunc(id)}`"]);
  });

  it("the cloud-management service sends no financial data: it renames the database and deletes it with the confirm flag", () => {
    const source = readFileSync(MANAGE, "utf8");
    expect(source.match(/^import .*$/gm)).toEqual(['import { API_ORIGIN, AccountError } from "./account";']);
    expect(source).not.toMatch(/@billie\/|\bFinanceStore\b|amountCents|merchantKey|\bStatement\b/);
    expect([...source.matchAll(/call\((`[^`]*`|"[^"]*"),\s*"(\w+)"/g)].map((match) => `${match[2]} ${match[1]}`)).toEqual(['PATCH ""', 'DELETE "?confirm=delete"']);
    expect(source).toMatch(/const FINANCE = `\$\{API_ORIGIN\}\/api\/client\/v1\/finance`/);
  });

  it("only the upload service sends statements: POST, one statement per request, to the statements endpoint", () => {
    const source = readFileSync(UPLOAD, "utf8");
    expect([...source.matchAll(/method:\s*"(\w+)"/g)].map((match) => match[1])).toEqual(["POST"]);
    expect(source).toMatch(/const ENDPOINT = `\$\{API_ORIGIN\}\/api\/client\/v1\/finance\/statements`/);
    expect(source.match(/fetch\(/g)?.length).toBe(1);
    // Nothing else may call the upload.
    const callers = all.filter((file) => file !== UPLOAD && /\buploadStatement\b/.test(readFileSync(file, "utf8")));
    expect(callers).toEqual([join(ROOT, "src/services/transfer.ts")]);
  });

  it("the metadata report sends only the allowlisted fields and can never carry financial content", () => {
    const source = readFileSync(REPORT, "utf8");
    expect(source.match(/^import .*$/gm)).toEqual(['import { API_ORIGIN, AccountError } from "./account";']);
    expect(source).not.toMatch(/@billie\/|\bFinanceStore\b|amountCents|merchantKey|description|filename|sha256|\bTransaction\b|\bStatement\b/);
    expect(source).toMatch(/const DEVICES = `\$\{API_ORIGIN\}\/api\/client\/v1\/devices`/);
    expect([...source.matchAll(/call\("(\w+)"/g)].map((match) => match[1])).toEqual(["PUT", "DELETE", "DELETE"]);
    const fields = /REPORT_FIELDS = \[([^\]]+)\]/.exec(source)![1].match(/"(\w+)"/g)!.map((f) => f.replace(/"/g, ""));
    expect(fields).toEqual(["name", "device_name", "platform", "size_bytes", "statement_count", "transaction_count", "rule_count", "period_start", "period_end", "modified_at", "opened_at", "synced_at", "sequence"]);
    // The settings and queue code only ever reaches the network through this file.
    expect(readFileSync(join(ROOT, "src/services/reporting.ts"), "utf8")).not.toMatch(/\bfetch\s*\(/);
  });

  it("AI categorization sends only cleaned merchant text, direction and category names, to the BillieWeather server", () => {
    const source = readFileSync(AI, "utf8");
    expect(source.match(/^import .*$/gm)).toEqual(['import { API_ORIGIN, AccountError } from "./account";']);
    expect(source).not.toMatch(/@billie\/|\bFinanceStore\b|amountCents|bookedOn|filename|sha256|merchantKey|\bStatement\b/);
    expect(source).toMatch(/const ENDPOINT = `\$\{API_ORIGIN\}\/api\/client\/v1\/finance\/categorize`/);
    expect([...source.matchAll(/method:\s*"(\w+)"/g)].map((match) => match[1])).toEqual(["POST"]);
    expect(source.match(/fetch\(/g)?.length).toBe(1);
    // The request body, field by field.
    const body = /body: JSON\.stringify\(\{([\s\S]*?)\}\),\n\s*credentials/.exec(source)![1];
    expect([...body.matchAll(/(\w+):/g)].map((match) => match[1])).toEqual(["consent", "categories", "items", "key", "description", "direction"]);
    expect(body).toMatch(/description: item\.text/);
    // Only the Categories page calls it, with text already cleaned on the device.
    const callers = all.filter((file) => file !== AI && /\brequestAiCategories\b/.test(readFileSync(file, "utf8")));
    expect(callers).toEqual([join(ROOT, "src/pages/Categories.tsx")]);
    expect(readFileSync(join(ROOT, "src/pages/Categories.tsx"), "utf8")).toMatch(/store\.aiCandidates\(\)/);
  });

  it("the app never talks to OpenAI directly", () => {
    expect(all.filter((file) => /openai\.com/i.test(readFileSync(file, "utf8")))).toEqual([]);
  });

  it("only the reviewed services know the server API paths", () => {
    expect(all.filter((file) => !NETWORK_FILES.includes(file) && /api\/client\/v1/.test(readFileSync(file, "utf8")))).toEqual([]);
  });

  it("no console logging or Rust print macros (financial data must stay out of logs)", () => {
    const offenders = all.filter((file) => /\bconsole\.(log|info|debug|warn|error|trace)\b|\b(println|eprintln|dbg|log::\w+)!/.test(readFileSync(file, "utf8")));
    expect(offenders).toEqual([]);
  });

  it("no cloud credentials or Neon/Render endpoints", () => {
    const offenders = all.filter((file) => /DATABASE_URL|neon\.tech|postgres(ql)?:\/\/|OPENAI_|sk-[A-Za-z0-9]{10,}|onrender\.com|api[_-]?key/i.test(readFileSync(file, "utf8")));
    expect(offenders).toEqual([]);
  });

  it("the base Content Security Policy allows only the local IPC bridge and the app's own bundled files", () => {
    const config = JSON.parse(readFileSync(join(ROOT, "src-tauri/tauri.conf.json"), "utf8"));
    const csp: string = config.app.security.csp;
    // 'self' is the app bundle itself: the on-device OCR worker loads its WASM core and models from it.
    expect((/connect-src ([^;]+)/.exec(csp)?.[1].trim().split(/\s+/) ?? []).sort()).toEqual(["'self'", "http://ipc.localhost", "ipc:"]);
    expect(csp).not.toMatch(/jsdelivr|unpkg|cdn|https:\/\/(?!ipc)/i);
    expect(csp).toMatch(/default-src 'self'/);
  });

  it("OCR assets are local files only and the Tesseract engine refuses to run without local paths", async () => {
    const source = readFileSync(join(ROOT, "vite.config.ts"), "utf8");
    const assets = source.slice(source.indexOf("export const OCR_ASSETS"), source.indexOf("function ocrAssets"));
    expect(assets).not.toMatch(/https?:\/\//);
    const engine = readFileSync(join(ROOT, "src/services/ocr/tesseractEngine.ts"), "utf8");
    expect(engine).toMatch(/workerBlobURL: false/);
    expect(engine).not.toMatch(/https?:\/\//);
    const { tesseractEngine } = await import("../src/services/ocr/tesseractEngine");
    expect(() => tesseractEngine({ workerPath: "", corePath: "", langPath: "", cacheMethod: "none" })).toThrow(/CDN/);
  });

  it("builds add exactly one origin — the BillieWeather server — and only over https", async () => {
    // @ts-expect-error plain JS build script
    const { apiOrigin, cspWithOrigin } = await import("../scripts/tauri.mjs");
    const config = JSON.parse(readFileSync(join(ROOT, "src-tauri/tauri.conf.json"), "utf8"));
    const csp = cspWithOrigin(config.app.security.csp, apiOrigin("https://billieweather.example.com/some/path"));
    expect((/connect-src ([^;]+)/.exec(csp)?.[1].trim().split(/\s+/) ?? []).sort()).toEqual(["'self'", "http://ipc.localhost", "https://billieweather.example.com", "ipc:"]);
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
