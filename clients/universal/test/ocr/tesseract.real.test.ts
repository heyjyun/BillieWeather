// REAL Tesseract (WebAssembly, tesseract.js) OCR, run in Node with the exact adapter the app uses
// (src/services/ocr/tesseractEngine.ts) and the exact model files the app ships. Feeds the real
// output through the real import pipeline. Rotation detection needs a canvas, which Node lacks,
// so the rotated fixture is expected to be unreadable here (it is covered in the browser test).
// Run it offline with: sandbox-exec -p '(version 1)(allow default)(deny network*)' npx vitest run test/ocr/tesseract.real.test.ts
import { mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { tesseractEngine } from "../../src/services/ocr/tesseractEngine";
import { OCR_ASSETS } from "../../vite.config";
import { draftFor, IMAGE_CASES, imagesFor, score, table, type Score } from "./realEngine";

const require = createRequire(import.meta.url);
const NODE_WORKER = join(dirname(require.resolve("tesseract.js/package.json")), "src/worker-script/node/index.js");

function engine() {
  const lang = mkdtempSync(join(tmpdir(), "billie-tess-lang-"));
  for (const [name, path] of Object.entries(OCR_ASSETS)) if (name.startsWith("ocr/lang/")) symlinkSync(path, join(lang, name.slice("ocr/lang/".length)));
  return tesseractEngine({ workerPath: NODE_WORKER, corePath: "node:tesseract.js-core", langPath: lang, cacheMethod: "none" });
}

describe("Tesseract WebAssembly (real engine, Node)", () => {
  const scores: Score[] = [];

  it.each(IMAGE_CASES)("%s: real recognition goes through the pipeline and never marks a wrong amount as ready", async (fixture) => {
    const result = await engine().recognize({ images: imagesFor(fixture), languages: ["en", "zh-Hans", "zh-Hant"] });
    expect(result.engine.id).toBe("tesseract-js");
    let s: Score;
    try {
      s = score(fixture, await draftFor(fixture, result));
    } catch (error) {
      // Unreadable (e.g. sideways without rotation support): refused, nothing imported.
      expect((error as { code?: string }).code).toBe("ocr_failed");
      s = { fixture, truthRows: 0, extractedRows: 0, correctRows: 0, readyRows: 0, wrongButReady: 0, needsReview: 0, rejected: 0, descriptionExact: 0, reviewRate: 1, committable: false };
    }
    scores.push(s);
    expect(s.wrongButReady).toBe(0);
    if (s.needsReview > 0) expect(s.committable).toBe(false);
  }, 180_000);

  it("reports HEIC as unsupported for this engine instead of guessing", async () => {
    const result = await engine().recognize({ images: [{ page: 1, bytes: new Uint8Array([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70]), kind: "heic" }], languages: ["en"] });
    expect(result.pages).toEqual([]);
    expect(result.errors).toEqual([{ page: 1, code: "unsupported_format", message: expect.any(String) }]);
    expect(result.unsupported).toContain("format:heic");
  }, 60_000);

  it("stops when cancelled", async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await engine().recognize({ images: imagesFor("us-debit-credit.png"), languages: ["en"], signal: controller.signal });
    expect(result.errors[0]).toMatchObject({ code: "cancelled" });
  }, 60_000);

  afterAll(() => {
    if (scores.length === 0) return;
    const report = table(scores);
    writeFileSync(join(tmpdir(), "billie-ocr-tesseract-node.txt"), `${report}\n`);
    console.log(`Tesseract (Node) results\n${report}`);
  });
});
