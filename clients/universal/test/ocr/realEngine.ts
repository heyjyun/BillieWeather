// Shared helpers for the real-engine OCR tests: ground truth, scoring, and the import pipeline
// driven by a real engine's output. Synthetic fixtures only (test/ocr-fixtures/generate.py).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Categorizer, commitPlan, createOcrDraft, decisionFor, reviseDraft, type ImportContext, type ImportDraft, type OcrEngine, type OcrImage, type OcrResult } from "@billie/finance-core";
import { CURRENCIES } from "@billie/shared-types";

export const FIXTURES = join(__dirname, "../ocr-fixtures");

export interface TruthRow { date: string; description: string; amountMinor: number; balanceMinor: number }
export interface Truth { currency: string; opening: number; rows: TruthRow[]; pages?: string[]; variant?: string }
export const TRUTH = JSON.parse(readFileSync(join(FIXTURES, "truth.json"), "utf8")) as Record<string, Truth>;

export const IMAGE_CASES = ["us-debit-credit.png", "us-signed-amount.jpg", "zh-cn.png", "zh-tw.png", "us-blurred.png", "us-rotated-90.png", "us-skew-3.png", "ambiguous-columns.png", "multipage"] as const;

export function imagesFor(name: string): OcrImage[] {
  const files = TRUTH[name].pages ?? [name];
  return files.map((file, index) => ({ page: index + 1, bytes: new Uint8Array(readFileSync(join(FIXTURES, file))), kind: file.endsWith(".jpg") ? "jpeg" : "png" }));
}

export function context(engine: OcrEngine, currency: string): ImportContext {
  return {
    categorizer: new Categorizer([]), customCategories: [], templates: [], existing: [], existingFileHashes: new Set(), deviceCurrency: currency,
    storableCurrencies: CURRENCIES, today: "2026-12-31", ocr: engine,
  };
}

export function fixedEngine(result: OcrResult): OcrEngine {
  return { info: { id: result.engine.id, location: "device", languages: result.languages }, recognize: async () => result };
}

export interface Score {
  fixture: string;
  truthRows: number;
  extractedRows: number;
  /** Truth rows found with the right date and amount (any status). */
  correctRows: number;
  /** Truth rows marked ready without review. */
  readyRows: number;
  /** Rows marked ready whose date, amount or direction is wrong. MUST be 0. */
  wrongButReady: number;
  needsReview: number;
  rejected: number;
  descriptionExact: number;
  reviewRate: number;
  committable: boolean;
}

/** Scores a draft against ground truth by matching each truth row to the extracted row with the same date and amount. */
export function score(fixture: string, draft: ImportDraft): Score {
  const truth = TRUTH[fixture];
  const used = new Set<string>();
  let correctRows = 0;
  let descriptionExact = 0;
  for (const expected of truth.rows) {
    const match = draft.rows.find((row) => !used.has(row.id) && row.transactionDate === expected.date && row.amountMinor === expected.amountMinor);
    if (!match) continue;
    used.add(match.id);
    correctRows += 1;
    if (match.originalDescription === expected.description) descriptionExact += 1;
  }
  const truthKeys = new Set(truth.rows.map((row) => `${row.date}|${row.amountMinor}`));
  const ready = draft.rows.filter((row) => decisionFor(draft, row) === "include" && row.status === "valid");
  const wrongButReady = ready.filter((row) => !truthKeys.has(`${row.transactionDate}|${row.amountMinor}`)).length;
  return {
    fixture, truthRows: truth.rows.length, extractedRows: draft.rows.length, correctRows,
    readyRows: ready.filter((row) => truthKeys.has(`${row.transactionDate}|${row.amountMinor}`)).length, wrongButReady,
    needsReview: draft.rows.filter((row) => row.status === "needs_review").length, rejected: draft.rows.filter((row) => row.status === "rejected").length,
    descriptionExact, reviewRate: draft.rows.length === 0 ? 1 : draft.rows.filter((row) => row.status !== "valid").length / draft.rows.length,
    committable: commitPlan(draft, { deviceCurrency: truth.currency, storableCurrencies: CURRENCIES }).ok,
  };
}

/** The Chinese script a person would pick for each fixture when the engine asks. */
const SCRIPT: Record<string, "zh-Hans" | "zh-Hant"> = { "zh-cn.png": "zh-Hans", "zh-tw.png": "zh-Hant" };

export async function draftFor(fixture: string, result: OcrResult): Promise<ImportDraft> {
  const truth = TRUTH[fixture];
  const images = imagesFor(fixture);
  const ctx = context(fixedEngine(result), truth.currency);
  const draft = await createOcrDraft({ bytes: images[0].bytes, filename: fixture, format: images.length > 1 ? "pdf_scanned" : "image", images }, ctx);
  return draft.needs.includes("ocrScript") ? reviseDraft(draft, { conventions: { ocrScript: SCRIPT[fixture] ?? "zh-Hans" } }, ctx) : draft;
}

export function table(scores: readonly Score[]): string {
  const head = "fixture | truth | extracted | correct date+amount | ready (verified) | WRONG but ready | review | rejected | desc exact | review rate";
  return [head, ...scores.map((s) => [s.fixture, s.truthRows, s.extractedRows, s.correctRows, s.readyRows, s.wrongButReady, s.needsReview, s.rejected, s.descriptionExact, `${Math.round(s.reviewRate * 100)}%`].join(" | "))].join("\n");
}
