// Receipt contract (parse, merchant identity, matching, duplicates). Rails replays the same fixtures in
// test/services/finance/receipt_contract_test.rb; both sides must agree on every case.
import parseCases from "../fixtures/receipts/parse-cases.json";
import matchCases from "../fixtures/receipts/match-cases.json";
import {
  findDuplicateReceipt, matchReceipt, merchantIdentity, merchantSimilarity, parseReceiptText, receiptConfident,
  type MatchCandidate, type ReceiptForDuplicate, type ReceiptForMatch, type ReceiptLine, type ReceiptParseOptions,
} from "../src";

type ParseCase = (typeof parseCases.cases)[number] & { text?: string; lines?: Array<string | ReceiptLine>; minConfidence?: Record<string, number>; maxConfidence?: Record<string, number> };
const FIELDS = ["merchant", "date", "time", "currency", "total", "subtotal", "tax", "tip", "discount", "paymentMethod", "cardLast4", "receiptNumber"] as const;

describe("receipt text parsing (parse-cases.json)", () => {
  for (const raw of parseCases.cases as ParseCase[]) {
    it(raw.name, () => {
      const input = raw.text ?? (raw.lines ?? []).map((line) => (typeof line === "string" ? { text: line, confidence: null } : line));
      const result = parseReceiptText(input, raw.options as ReceiptParseOptions);
      const expected = raw.expect as Record<string, unknown>;
      for (const name of FIELDS) {
        if (name in expected) expect(result[name].value, name).toEqual(expected[name]);
      }
      if ("direction" in expected) expect(result.direction).toBe(expected.direction);
      if ("issues" in expected) expect(result.issues).toEqual(expected.issues);
      if ("confident" in expected) expect(receiptConfident(result), "confident").toBe(expected.confident);
      if ("lineItemCount" in expected) expect(result.lineItems.length, "line items").toBe(expected.lineItemCount);
      if (expected.lineItem) {
        const { index, ...item } = expected.lineItem as Record<string, unknown> & { index: number };
        expect(result.lineItems[index]).toMatchObject(item);
      }
      for (const [name, min] of Object.entries(raw.minConfidence ?? {})) expect(result[name as (typeof FIELDS)[number]].confidence, `${name} ≥`).toBeGreaterThanOrEqual(min);
      for (const [name, max] of Object.entries(raw.maxConfidence ?? {})) expect(result[name as (typeof FIELDS)[number]].confidence, `${name} ≤`).toBeLessThanOrEqual(max);
      // Unknown means unknown: a null value never carries confidence.
      for (const name of FIELDS) if (result[name].value === null) expect(result[name].confidence).toBe(0);
    });
  }
});

describe("merchant identity (match-cases.json merchants)", () => {
  it("normalizes bank descriptors to one key", () => {
    for (const [text, key] of matchCases.merchants.keys as Array<[string, string | null]>) expect(merchantIdentity(text).key, text).toBe(key);
  });
  it("scores similarity within the expected bands", () => {
    for (const [a, b, min, max] of matchCases.merchants.similarity as Array<[string | null, string, number | null, number | null]>) {
      const score = merchantSimilarity(a, b);
      if (min === null) expect(score, `${a} / ${b}`).toBeNull();
      else {
        expect(score, `${a} / ${b}`).toBeGreaterThanOrEqual(min);
        expect(score, `${a} / ${b}`).toBeLessThanOrEqual(max!);
      }
    }
  });
});

describe("receipt ↔ ledger matching (match-cases.json cases)", () => {
  for (const raw of matchCases.cases) {
    it(raw.name, () => {
      const result = matchReceipt(raw.receipt as ReceiptForMatch, raw.candidates as MatchCandidate[]);
      expect(result.level).toBe(raw.expect.level);
      expect(result.best?.ids ?? null).toEqual(raw.expect.ids);
      const expected = raw.expect as { reasons?: string[]; proposals?: number };
      for (const reason of expected.reasons ?? []) expect(result.best?.reasons, reason).toContain(reason);
      if (expected.proposals !== undefined) expect(result.proposals.length).toBe(expected.proposals);
      // Never merged on the amount alone: an exact match always names the same merchant or a proven reference.
      if (result.level === "exact") expect(result.best!.reasons.some((reason) => ["merchant_same", "merchant_similar", "receipt_number_match"].includes(reason))).toBe(true);
    });
  }
});

describe("receipt duplicates (match-cases.json duplicates)", () => {
  for (const raw of matchCases.duplicates) {
    it(raw.name, () => {
      expect(findDuplicateReceipt(raw.incoming as ReceiptForDuplicate, raw.existing as ReceiptForDuplicate[])).toEqual(raw.expect);
    });
  }
});
