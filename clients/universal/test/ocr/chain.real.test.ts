// The whole desktop chain with both REAL engines: Apple Vision (the Swift source the app links) reads what
// it can, the bundled Tesseract reads the pages Vision failed on, and the import pipeline gets one document.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createOcrDraft } from "@billie/finance-core";
import { appleVisionDesktopEngine } from "../../src/services/ocr/nativeEngines";
import { tesseractEngine } from "../../src/services/ocr/tesseractEngine";
import { OCR_ASSETS } from "../../vite.config";
import { context, draftFor, FIXTURES, imagesFor, score, TRUTH } from "./realEngine";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

const require = createRequire(import.meta.url);
const SWIFT = join(__dirname, "../../src-tauri/ocr-apple");
const available = process.platform === "darwin" && (() => { try { execFileSync("xcrun", ["--find", "swiftc"], { stdio: "ignore" }); return true; } catch { return false; } })();

describe.skipIf(!available)("Vision then Tesseract (real engines)", () => {
  let cli = "";
  let dir = "";
  let reads: number[] = [];
  let failing = new Set<number>();
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "billie-chain-"));
    cli = join(dir, "cli");
    execFileSync("xcrun", ["swiftc", "-O", join(SWIFT, "BillieVisionOCR.swift"), join(SWIFT, "cli/main.swift"), "-o", cli], { stdio: "pipe", timeout: 170_000 });
  }, 180_000);
  beforeEach(() => {
    reads = []; failing = new Set();
    // Stands in for the Tauri command only; the recognition is real.
    invoke.mockReset().mockImplementation(async (command: string, bytes: Uint8Array, options: { headers: Record<string, string> }) => {
      if (command !== "ocr_recognize_image") return undefined;
      const page = Number(options.headers["x-ocr-page"]);
      reads.push(page);
      if (failing.has(page)) throw "ocr_failed";
      const file = join(dir, `page-${page}.png`);
      writeFileSync(file, bytes);
      const result = JSON.parse(execFileSync(cli, [options.headers["x-ocr-languages"], file], { encoding: "utf8", timeout: 25_000 }).trim());
      return { ...result, pages: result.pages.map((item: object) => ({ ...item, page })), errors: (result.errors ?? []).map((item: object) => ({ ...item, page })) };
    });
  });
  const tesseract = async () => {
    const lang = mkdtempSync(join(tmpdir(), "billie-chain-lang-"));
    for (const [name, path] of Object.entries(OCR_ASSETS)) if (name.startsWith("ocr/lang/")) symlinkSync(path, join(lang, name.slice("ocr/lang/".length)));
    return tesseractEngine({ workerPath: join(dirname(require.resolve("tesseract.js/package.json")), "src/worker-script/node/index.js"), corePath: "node:tesseract.js-core", langPath: lang, cacheMethod: "none" });
  };
  const chain = () => appleVisionDesktopEngine(tesseract);

  it("a page Vision fails on is read by Tesseract; no row is lost, doubled or wrongly ready", async () => {
    failing = new Set([2]);
    const images = imagesFor("multipage");
    const result = await chain().recognize({ images, languages: ["en", "zh-Hans", "zh-Hant"] });
    expect(result.pages.map((page) => page.page)).toEqual([1, 2]);
    expect(result.errors).toEqual([]);
    const s = score("multipage", await draftFor("multipage", result));
    expect(s.wrongButReady).toBe(0);
    expect(s.extractedRows).toBe(TRUTH.multipage.rows.length);
    expect(s.correctRows).toBe(TRUTH.multipage.rows.length);
    if (s.needsReview > 0) expect(s.committable).toBe(false);
  }, 180_000);

  it("Vision out of order entirely: the whole document is read by Tesseract", async () => {
    failing = new Set([1, 2]);
    const result = await chain().recognize({ images: imagesFor("multipage"), languages: ["en"] });
    expect(result.engine.id).toBe("tesseract-js");
    expect(result.pages).toHaveLength(2);
  }, 180_000);

  it.each([
    ["random bytes", () => Uint8Array.from({ length: 4000 }, (_, i) => (i * 37) % 256)],
    ["an empty file", () => new Uint8Array()],
    ["a truncated image", () => new Uint8Array(readFileSync(join(FIXTURES, "us-debit-credit.png"))).slice(0, 900)],
  ])("%s is refused by both engines and can never become a draft", async (_name, bytes) => {
    const images = [{ page: 1, bytes: bytes(), kind: "png" as const }];
    const engine = chain();
    const result = await engine.recognize({ images, languages: ["en"] });
    expect(result.pages.flatMap((page) => page.lines)).toEqual([]);
    await expect(createOcrDraft({ bytes: new Uint8Array([1]), filename: "x.png", format: "image", images }, context(engine, "USD"))).rejects.toMatchObject({ code: "ocr_failed" });
  }, 180_000);

  it("a document with one damaged page cannot be saved until a person accepts the missing page", async () => {
    const [first] = imagesFor("multipage");
    const images = [first, { page: 2, bytes: Uint8Array.from({ length: 4000 }, (_, i) => (i * 37) % 256), kind: "png" as const }];
    const engine = chain();
    const draft = await createOcrDraft({ bytes: new Uint8Array([1]), filename: "x.pdf", format: "pdf_scanned", images }, context(engine, "USD"));
    expect(draft.ocr?.missingPages).toEqual([2]);
    expect(draft.needs).toContain("ocrPages");
  }, 180_000);

  it("repeats without drift or leftovers", async () => {
    const image = imagesFor("us-debit-credit.png");
    const texts = new Set<string>();
    for (let i = 0; i < 5; i += 1) texts.add(JSON.stringify((await chain().recognize({ images: image, languages: ["en"] })).pages.map((page) => page.lines.map((item) => item.text))));
    expect(texts.size).toBe(1);
    expect(reads).toHaveLength(5);
  }, 180_000);
});
