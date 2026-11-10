// REAL Tesseract WebAssembly OCR in a real Chromium (the engine used on the Web and in Windows
// WebView2 builds), including pdf.js rendering of an image-only PDF. Every request the page and
// its workers make is recorded, and DNS for every host except localhost is disabled: OCR must
// work with only the app's own origin. Skipped if Playwright's Chromium is not installed.
import { createServer, type ViteDevServer } from "vite";
import { chromium, type Browser } from "playwright-core";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { table, TRUTH, type Score } from "./realEngine";

let browserAvailable = true;
try {
  await (await chromium.launch()).close();
} catch {
  browserAvailable = false;
}

type Run = { milliseconds: number; engine: { id: string; version: string }; unsupported: string[]; pages: Array<{ rotation: number }>; scanned: number[] | null; needs: string[]; committable: boolean;
  rows: Array<{ date: string | null; amount: number | null; status: string; decision: string; description: string; page?: number }> };

function scoreRun(fixture: string, run: Run): Score {
  const truth = TRUTH[fixture];
  const keys = new Set(truth.rows.map((row) => `${row.date}|${row.amountMinor}`));
  const used = new Set<number>();
  let correct = 0;
  let descriptionExact = 0;
  for (const expected of truth.rows) {
    const index = run.rows.findIndex((row, i) => !used.has(i) && row.date === expected.date && row.amount === expected.amountMinor);
    if (index < 0) continue;
    used.add(index);
    correct += 1;
    if (run.rows[index].description === expected.description) descriptionExact += 1;
  }
  const ready = run.rows.filter((row) => row.status === "valid" && row.decision === "include");
  return {
    fixture, truthRows: truth.rows.length, extractedRows: run.rows.length, correctRows: correct, readyRows: ready.filter((row) => keys.has(`${row.date}|${row.amount}`)).length,
    wrongButReady: ready.filter((row) => !keys.has(`${row.date}|${row.amount}`)).length, needsReview: run.rows.filter((row) => row.status === "needs_review").length,
    rejected: run.rows.filter((row) => row.status === "rejected").length, descriptionExact,
    reviewRate: run.rows.length === 0 ? 1 : run.rows.filter((row) => row.status !== "valid").length / run.rows.length, committable: run.committable,
  };
}

describe.skipIf(!browserAvailable)("Tesseract WebAssembly in Chromium (real engine, network guarded)", () => {
  let server: ViteDevServer;
  let browser: Browser;
  let origin = "";
  const requests: string[] = [];
  const scores: Score[] = [];
  let page: Awaited<ReturnType<Browser["newPage"]>>;
  let context: Awaited<ReturnType<Browser["newContext"]>>;

  beforeAll(async () => {
    server = await createServer({ configFile: join(__dirname, "../../vite.config.ts"), server: { port: 0, strictPort: false, hmr: false }, logLevel: "silent" });
    await server.listen();
    origin = `http://localhost:${(server.httpServer!.address() as { port: number }).port}`;
    // Any host other than localhost fails to resolve, for the page and all of its workers.
    browser = await chromium.launch({ args: ["--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost"] });
    context = await browser.newContext();
    context.on("request", (request) => requests.push(request.url()));
    page = await context.newPage();
    page.on("worker", (worker) => requests.push(`worker:${worker.url()}`));
    await page.goto(`${origin}/e2e/ocr.html`);
    await page.waitForFunction(() => document.getElementById("status")?.textContent?.startsWith("ready"), undefined, { timeout: 60_000 });
    expect(await page.textContent("#status")).toBe("ready"); // the OCR service worker controls the page
  }, 120_000);

  afterAll(async () => {
    await browser?.close();
    await server?.close();
    if (scores.length > 0) {
      const report = table(scores);
      writeFileSync(join(tmpdir(), "billie-ocr-tesseract-chromium.txt"), `${report}\n`);
      console.log(`Tesseract (Chromium) results\n${report}`);
    }
  });

  const run = (files: string[], currency: string, script?: string) => page.evaluate(([f, c, s]) => (window as unknown as { runOcr: (...args: unknown[]) => Promise<unknown> }).runOcr(f, c, s), [files, currency, script] as const) as Promise<Run>;

  const CASES: Array<[string, string[], string?]> = [
    ["us-debit-credit.png", ["us-debit-credit.png"]], ["us-signed-amount.jpg", ["us-signed-amount.jpg"]], ["zh-cn.png", ["zh-cn.png"], "zh-Hans"],
    ["zh-tw.png", ["zh-tw.png"], "zh-Hant"], ["us-blurred.png", ["us-blurred.png"]], ["us-rotated-90.png", ["us-rotated-90.png"]], ["us-skew-3.png", ["us-skew-3.png"]],
    ["ambiguous-columns.png", ["ambiguous-columns.png"]], ["multipage", ["multipage-1.png", "multipage-2.png"]], ["scanned-statement.pdf", ["scanned-statement.pdf"]],
  ];

  it.each(CASES)("%s", async (fixture, files, script) => {
    const result = await run(files, TRUTH[fixture].currency, script);
    expect(result.engine.id).toBe("tesseract-js");
    const s = scoreRun(fixture, result);
    scores.push(s);
    expect(s.wrongButReady).toBe(0);
    if (s.needsReview > 0) expect(result.committable).toBe(false);
    if (fixture === "scanned-statement.pdf") {
      // The PDF has no text layer: both pages were rendered locally and read in order.
      expect(result.scanned).toEqual([1, 2]);
      expect([...new Set(result.rows.map((row) => row.page))]).toEqual([1, 2]);
    }
    if (fixture === "us-rotated-90.png") expect(result.pages[0].rotation).toBe(90);
  }, 240_000);

  it("made no request outside the app's own origin (page and workers)", () => {
    const outside = requests.map((url) => url.replace(/^worker:/, "")).filter((url) => !url.startsWith(origin) && !url.startsWith("blob:") && !url.startsWith("data:"));
    expect(outside).toEqual([]);
    // The engine's assets came from the app itself.
    expect(requests.some((url) => url.startsWith(`${origin}/ocr/lang/eng.traineddata.gz`))).toBe(true);
    expect(requests.some((url) => /\/ocr\/core\/tesseract-core-.*lstm\.wasm\.js$/.test(url))).toBe(true);
  });

  it("after the first use, works with the browser offline (models cached on the device)", async () => {
    await context.setOffline(true);
    try {
      const result = await run(["us-debit-credit.png"], "USD");
      expect(scoreRun("us-debit-credit.png", result).correctRows).toBe(8);
    } finally {
      await context.setOffline(false);
    }
  }, 240_000);
});
