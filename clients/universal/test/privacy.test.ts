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
  // receiptUpload.ts: "Send to BillieWeather web" for one captured receipt, only when the person presses the button.
  const RECEIPT = join(ROOT, "src/services/receiptUpload.ts");
  // registration.ts: creating an account in the app, with the separate identity service (services/identity-api).
  const REGISTRATION = join(ROOT, "src/services/registration.ts");
  const NETWORK_FILES = [ACCOUNT, WEB_SYNC, CLOUD, MANAGE, UPLOAD, REPORT, AI, RECEIPT, REGISTRATION];

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
    // Only the Categories page and the "Organize with AI" panel call it, with text already cleaned on the device
    // (aiGroups/cleanForAi: no digits, no email addresses), and only after the person chose the AI option.
    const callers = all.filter((file) => file !== AI && /\brequestAiCategories\b/.test(readFileSync(file, "utf8"))).sort();
    expect(callers).toEqual([join(ROOT, "src/components/OrganizePanel.tsx"), join(ROOT, "src/pages/Categories.tsx")]);
    expect(readFileSync(join(ROOT, "src/pages/Categories.tsx"), "utf8")).toMatch(/store\.aiCandidates\(\)/);
    expect(readFileSync(join(ROOT, "src/components/OrganizePanel.tsx"), "utf8")).toMatch(/cloud && token \? \{ cloud: \(items, custom\) => requestAiCategories\(token, items, custom\) \}/);
    expect(readFileSync(join(ROOT, "src/services/organize.ts"), "utf8")).toMatch(/aiGroups\(leftover/);
  });

  it("only the receipt screen sends a receipt: one POST to the receipts endpoint, with a fixed body, after the Send button", () => {
    const source = readFileSync(RECEIPT, "utf8");
    expect(source.match(/^import .*$/gm)).toEqual(['import { API_ORIGIN, AccountError } from "./account";']);
    expect(source).not.toMatch(/@billie\/|\bFinanceStore\b|merchantKey|\bStatement\b|sha256/);
    expect(source).toMatch(/const ENDPOINT = `\$\{API_ORIGIN\}\/api\/client\/v1\/finance\/receipts`/);
    expect([...source.matchAll(/method:\s*"(\w+)"/g)].map((match) => match[1])).toEqual(["POST"]);
    expect(source.match(/fetch\(/g)?.length).toBe(1);
    // The request body, key by key: no account, ledger or other receipts ever travel with it.
    const body = /body: JSON\.stringify\(\{([\s\S]*?)\}\),\n\s*credentials/.exec(source)![1];
    expect([...body.matchAll(/(\w+):/g)].map((match) => match[1])).toEqual(["receipt", "client_request_id", "source", "engine", "lines", "text", "confidence", "fields", "file_base64", "filename", "content_type"]);
    expect(source).toMatch(/MAX_RECEIPT_UPLOAD_BYTES = 8 \* 1024 \* 1024/);
    // Only the receipt page calls it, from the Send button's handler.
    const callers = all.filter((file) => file !== RECEIPT && /\bsendReceipt\b/.test(readFileSync(file, "utf8")));
    expect(callers).toEqual([join(ROOT, "src/pages/Receipt.tsx")]);
    const page = readFileSync(join(ROOT, "src/pages/Receipt.tsx"), "utf8");
    expect(page.match(/sendReceipt\(/g)?.length).toBe(1);
    expect(page).toMatch(/onClick=\{\(\) => void send\(\)\}/);
    // Deep links name a screen only: the adapter has no network code and reads no query data.
    const links = readFileSync(join(ROOT, "src/services/deepLink.ts"), "utf8");
    expect(links).not.toMatch(/\bfetch\s*\(|api\/client|searchParams|URLSearchParams/);
  });

  it("registration sends only sign-up details, to the identity service, and sees no financial code", () => {
    const source = readFileSync(REGISTRATION, "utf8");
    expect(source.match(/^import .*$/gm) ?? []).toEqual([]);
    expect(source).not.toMatch(/@billie\/|\bFinanceStore\b|\bTransaction\b|\bStatement\b|amountCents|merchantKey|sqlite|localStorage|sessionStorage/i);
    expect(source).toMatch(/const API = `\$\{IDENTITY_ORIGIN\}\/v1`/);
    expect(source.match(/fetch\(/g)?.length).toBe(1);
    expect(source).not.toMatch(/api\/client\/v1/);
    // Every endpoint it can call.
    const paths = [...source.matchAll(/call<[^(]*\(\s*(`[^`]*`|"[^"]*")/g)].map((match) => match[1]).sort();
    expect(paths).toEqual([
      '"/config"', '"/google/flows"', '"/registrations"',
      "`/google/flows/${segment(flow.id)}/cancel`", "`/google/flows/${segment(flow.id)}/complete`", "`/google/flows/${segment(flow.id)}/link`",
      "`/google/flows/${segment(flow.id)}/status`", "`/registrations/${segment(pending.id)}/confirmation`", "`/registrations/${segment(pending.id)}/resend`",
    ].sort());
    // Every key any request body may carry.
    const bodies = [...source.matchAll(/"POST",\s*\{([^}]*)\}/g)].map((match) => match[1]);
    expect(bodies.length).toBe(8);
    const keys = new Set(bodies.flatMap((body) => body.split(",").map((part) => part.split(":")[0].trim()).filter(Boolean)));
    expect([...keys].sort()).toEqual(["code", "code_challenge", "code_challenge_method", "code_verifier", "email", "locale", "nickname", "password", "password_confirmation", "registration_secret", "usage_region"].sort());
    // Only the Create Account screen uses it.
    const callers = all.filter((file) => file !== REGISTRATION && /services\/registration"/.test(readFileSync(file, "utf8")));
    expect(callers).toEqual([join(ROOT, "src/pages/Register.tsx")]);
    // No website sign-up detour remains.
    expect(all.filter((file) => /users\/sign_up/.test(readFileSync(file, "utf8")))).toEqual([]);
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

  it("builds add exactly two origins — the BillieWeather server and its identity service — and only over https", async () => {
    // @ts-expect-error plain JS build script
    const { apiOrigin, identityOrigin, cspWithOrigin } = await import("../scripts/tauri.mjs");
    const config = JSON.parse(readFileSync(join(ROOT, "src-tauri/tauri.conf.json"), "utf8"));
    const csp = cspWithOrigin(config.app.security.csp, apiOrigin("https://billieweather.example.com/some/path"), identityOrigin("https://identity.billieweather.example.com/v1"));
    expect((/connect-src ([^;]+)/.exec(csp)?.[1].trim().split(/\s+/) ?? []).sort()).toEqual(["'self'", "http://ipc.localhost", "https://billieweather.example.com", "https://identity.billieweather.example.com", "ipc:"]);
    expect(apiOrigin(undefined)).toBe("http://localhost:3000");
    expect(identityOrigin(undefined)).toBe("http://localhost:8100");
    expect(() => apiOrigin("http://billieweather.example.com")).toThrow(/https/);
    expect(() => identityOrigin("http://identity.example.com")).toThrow(/BILLIE_IDENTITY_URL must be https/);
  });

  it("the app requests no network, shell, or broad file-system permissions", () => {
    const capability = JSON.parse(readFileSync(join(ROOT, "src-tauri/capabilities/default.json"), "utf8"));
    const permissions: string[] = capability.permissions.map((p: string | { identifier: string }) => (typeof p === "string" ? p : p.identifier));
    // Reading is allowed only for the single file picked in the open dialog (backup restore): no fs scope is granted.
    expect(permissions.filter((p) => /^(http|shell|fs:allow-read|fs:scope|fs:default|opener:default)/.test(p))).toEqual(["fs:allow-read-file"]);
    expect(permissions.filter((p) => /^fs:/.test(p)).sort()).toEqual(["fs:allow-read-file", "fs:allow-write-file"]);
  });

  it("the local database file and build output are git-ignored", () => {
    const ignore = readFileSync(join(ROOT, ".gitignore"), "utf8");
    for (const pattern of ["*.db", "*.sqlite", "node_modules/", "src-tauri/target/"]) expect(ignore).toContain(pattern);
  });
});
