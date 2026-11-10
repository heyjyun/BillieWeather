// REAL Apple Vision OCR (macOS only): compiles the exact Swift source the app links
// (src-tauri/ocr-apple/BillieVisionOCR.swift) into a CLI, runs it on synthetic statement images
// and feeds the real output through the real import pipeline. Skipped on other platforms.
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mergeOcrResults, parseOcrResult, type OcrResult } from "@billie/finance-core";
import { draftFor, FIXTURES, IMAGE_CASES, score, table, TRUTH, type Score } from "./realEngine";

const SWIFT = join(__dirname, "../../src-tauri/ocr-apple");
const available = process.platform === "darwin" && (() => {
  try {
    execFileSync("xcrun", ["--find", "swiftc"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

describe.skipIf(!available)("Apple Vision (real engine)", () => {
  let cli = "";
  const scores: Score[] = [];

  beforeAll(() => {
    const dir = mkdtempSync(join(tmpdir(), "billie-vision-"));
    cli = join(dir, "billie-vision-cli");
    execFileSync("xcrun", ["swiftc", "-O", join(SWIFT, "BillieVisionOCR.swift"), join(SWIFT, "cli/main.swift"), "-o", cli], { stdio: "pipe" });
  }, 180_000);

  /** Runs the CLI with networking denied by the macOS sandbox: recognition must not need the network. */
  function recognize(files: string[], offline = true): OcrResult {
    const args = ["en-US,zh-Hans,zh-Hant", ...files.map((file) => join(FIXTURES, file))];
    const output = offline
      ? execFileSync("/usr/bin/sandbox-exec", ["-p", "(version 1)(allow default)(deny network*)", cli, ...args], { encoding: "utf8" })
      : execFileSync(cli, args, { encoding: "utf8" });
    return mergeOcrResults(output.trim().split("\n").map((line) => parseOcrResult(JSON.parse(line))));
  }

  it.each(IMAGE_CASES)("%s: real recognition goes through the pipeline and never marks a wrong amount as ready", async (fixture) => {
    const result = recognize(TRUTH[fixture].pages ?? [fixture]);
    expect(result.engine.id).toBe("apple-vision");
    expect(result.errors).toEqual([]);
    const draft = await draftFor(fixture, result);
    const s = score(fixture, draft);
    scores.push(s);
    // The safety property: a row is only "ready" when it is right.
    expect(s.wrongButReady).toBe(0);
    // Nothing is committed silently: if anything is unverified, the plan is blocked until reviewed.
    if (s.needsReview > 0) expect(s.committable).toBe(false);
  }, 60_000);

  it("works with the network disabled (sandbox) and gives the same result as with network", () => {
    const online = recognize(["zh-cn.png"], false);
    const offline = recognize(["zh-cn.png"], true);
    expect(offline.pages[0].lines.map((line) => line.text)).toEqual(online.pages[0].lines.map((line) => line.text));
  }, 60_000);

  it("detects rotation and reports boxes in the upright frame", () => {
    const rotated = recognize(["us-rotated-90.png"]);
    expect(rotated.pages[0]).toMatchObject({ rotation: 90, width: 1700 });
    const title = rotated.pages[0].lines.find((line) => line.text === "Synthetic Bank")!;
    const upright = recognize(["us-debit-credit.png"]).pages[0].lines.find((line) => line.text === "Synthetic Bank")!;
    expect(Math.abs(title.y - upright.y)).toBeLessThan(5);
  }, 60_000);

  it("reports undecodable input as an error instead of text", () => {
    const dir = mkdtempSync(join(tmpdir(), "billie-vision-bad-"));
    writeFileSync(join(dir, "bad.png"), "not an image");
    const output = execFileSync(cli, ["en-US", join(dir, "bad.png")], { encoding: "utf8" });
    expect(parseOcrResult(JSON.parse(output))).toMatchObject({ pages: [], errors: [{ code: "decode_failed" }] });
  }, 60_000);

  afterAll(() => {
    if (scores.length === 0) return;
    const report = table(scores);
    writeFileSync(join(tmpdir(), "billie-ocr-apple-vision.txt"), `${report}\n`);
    console.log(`Apple Vision results\n${report}`);
  });
});
