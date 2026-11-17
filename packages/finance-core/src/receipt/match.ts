// Receipt ↔ ledger matching and receipt ↔ receipt duplicate detection, explainable and conservative.
// Shared with Rails (app/services/finance/receipt_matcher.rb); both replay fixtures/receipts/match-cases.json.
//
// Deduplication answers "do these records describe the same purchase?". It never merges on the
// amount alone, never compares across currencies, and never links a transfer, a card payment or an
// entry that already has a receipt. Levels:
//   exact      amount equal + same merchant + posted 0–3 days after + key fields trusted + the only
//              plausible candidate (or the receipt number equals the bank reference). The only level
//              that may be linked automatically.
//   probable   one strong candidate that misses a condition of exact (later posting, untrusted OCR,
//              a weaker merchant name proved by the card's last four digits). A person confirms.
//   ambiguous  several strong candidates, the amount alone, a tip-sized difference, a split payment
//              or another currency. A person decides.
//   none       nothing plausible: the receipt stays on its own (cash, or the bank has not posted yet).
import { merchantSimilarity } from "./merchant";

export type MatchLevel = "exact" | "probable" | "ambiguous" | "none";
export type MatchReason =
  | "amount_equal" | "amount_differs_tip" | "split_payment" | "currency_differs"
  | "merchant_same" | "merchant_similar" | "merchant_weak" | "merchant_unknown"
  | "same_day" | "posted_later" | "posted_earlier" | "card_last4_match" | "receipt_number_match"
  | "multiple_candidates" | "similar_candidates" | "low_confidence";

export interface ReceiptForMatch {
  /** Total in minor units, always positive; `direction` says which way the money went. */
  amountMinor: number;
  direction: "purchase" | "refund";
  currency: string | null;
  /** Purchase date, "YYYY-MM-DD". */
  date: string;
  merchant: string | null;
  cardLast4?: string | null;
  receiptNumber?: string | null;
  tipMinor?: number | null;
  /** Merchant, date and total are trusted (RECEIPT_CONFIDENT, or confirmed by a person). */
  confident: boolean;
}

export interface MatchCandidate {
  id: string | number;
  /** Signed from the account's point of view: a purchase is negative. */
  amountMinor: number;
  currency: string | null;
  /** Posting date, "YYYY-MM-DD". */
  date: string;
  description: string;
  kind: string;
  accountLast4?: string | null;
  reference?: string | null;
  /** Already evidenced by another receipt. */
  hasReceipt?: boolean;
  /** A person said this receipt and this entry are different purchases. */
  rejected?: boolean;
}

export interface MatchProposal {
  level: Exclude<MatchLevel, "none">;
  ids: Array<string | number>;
  score: number;
  reasons: MatchReason[];
  dayOffset: number;
}

export interface MatchResult {
  level: MatchLevel;
  best: MatchProposal | null;
  proposals: MatchProposal[];
}

/** Days a bank may post before (time zones) or after the purchase. */
export const POSTING_WINDOW = { before: 1, after: 7 } as const;
const EXACT_DAYS = 3;
const TIP_LIMIT = 0.3;

const PURCHASE_KINDS = new Set(["expense"]);
const REFUND_KINDS = new Set(["refund", "income"]);

export function dayNumber(iso: string): number {
  const [year, month, day] = iso.split("-").map(Number);
  return Math.round(Date.UTC(year, month - 1, day) / 86_400_000);
}

const normalizeId = (value: string | null | undefined) => (value ? value.replace(/[^A-Za-z0-9]/g, "").toUpperCase() : "");

function compareProposals(a: MatchProposal, b: MatchProposal): number {
  return b.score - a.score || Math.abs(a.dayOffset) - Math.abs(b.dayOffset) || String(a.ids[0]).localeCompare(String(b.ids[0]), "en", { numeric: true });
}

export function matchReceipt(receipt: ReceiptForMatch, candidates: ReadonlyArray<MatchCandidate>): MatchResult {
  const kinds = receipt.direction === "refund" ? REFUND_KINDS : PURCHASE_KINDS;
  const receiptDay = dayNumber(receipt.date);
  const receiptNumber = normalizeId(receipt.receiptNumber);
  const eligible = candidates.filter((candidate) => {
    if (candidate.rejected || candidate.hasReceipt || !kinds.has(candidate.kind)) return false;
    if (receipt.direction === "purchase" ? candidate.amountMinor >= 0 : candidate.amountMinor <= 0) return false;
    const offset = dayNumber(candidate.date) - receiptDay;
    if (offset < -POSTING_WINDOW.before || offset > POSTING_WINDOW.after) return false;
    // A different card is a different payment.
    if (receipt.cardLast4 && candidate.accountLast4 && receipt.cardLast4 !== candidate.accountLast4) return false;
    return true;
  });

  const proposals: MatchProposal[] = [];
  for (const candidate of eligible) {
    const offset = dayNumber(candidate.date) - receiptDay;
    const similarity = merchantSimilarity(receipt.merchant, candidate.description);
    const sameCurrency = !receipt.currency || !candidate.currency || receipt.currency === candidate.currency;
    const magnitude = Math.abs(candidate.amountMinor);
    const referenceMatch = receiptNumber.length >= 4 && receiptNumber === normalizeId(candidate.reference);
    const last4Match = Boolean(receipt.cardLast4 && candidate.accountLast4 && receipt.cardLast4 === candidate.accountLast4);
    const reasons: MatchReason[] = [];

    if (!sameCurrency) {
      // Amounts in two currencies cannot be compared without a rate: the merchant and date must carry it.
      if (similarity === null || similarity < 0.8) continue;
      reasons.push("currency_differs", similarity === 1 ? "merchant_same" : "merchant_similar");
      reasons.push(offset === 0 ? "same_day" : offset > 0 ? "posted_later" : "posted_earlier");
      proposals.push({ level: "ambiguous", ids: [candidate.id], score: Math.round(30 * similarity + Math.max(0, 20 - 3 * Math.abs(offset))), reasons, dayOffset: offset });
      continue;
    }

    const amountEqual = magnitude === receipt.amountMinor;
    const tipLike = !amountEqual && receipt.direction === "purchase" && (receipt.tipMinor ?? null) === null
      && magnitude > receipt.amountMinor && magnitude - receipt.amountMinor <= Math.round(receipt.amountMinor * TIP_LIMIT);
    if (!amountEqual && !tipLike) continue;
    // A clearly different business is a different purchase, whatever the amount (unless the bank's reference proves it).
    if (similarity !== null && similarity < 0.3 && !referenceMatch) continue;
    if (tipLike && (similarity === null || similarity < 0.8)) continue;

    reasons.push(amountEqual ? "amount_equal" : "amount_differs_tip");
    if (similarity === null) reasons.push("merchant_unknown");
    else if (similarity === 1) reasons.push("merchant_same");
    else if (similarity >= 0.8) reasons.push("merchant_similar");
    else reasons.push("merchant_weak");
    reasons.push(offset === 0 ? "same_day" : offset > 0 ? "posted_later" : "posted_earlier");
    if (last4Match) reasons.push("card_last4_match");
    if (referenceMatch) reasons.push("receipt_number_match");
    if (!receipt.confident) reasons.push("low_confidence");

    const score = Math.min(100, (amountEqual ? 40 : 20) + Math.round(30 * (similarity ?? 0)) + Math.max(0, 20 - 3 * Math.max(0, offset)) - (offset < 0 ? 5 : 0)
      + (last4Match ? 10 : 0) + (referenceMatch ? 20 : 0));
    const strongMerchant = similarity !== null && similarity >= 0.8;
    let level: MatchProposal["level"];
    if (amountEqual && referenceMatch) level = "exact";
    else if (amountEqual && strongMerchant && offset >= 0 && offset <= EXACT_DAYS && receipt.confident) level = "exact";
    else if (amountEqual && strongMerchant) level = "probable";
    else if (amountEqual && similarity !== null && similarity >= 0.5 && last4Match) level = "probable";
    else level = "ambiguous";
    proposals.push({ level, ids: [candidate.id], score, reasons, dayOffset: offset });
  }

  // Split payment: no single entry has the amount, but two entries at the same merchant add up to it.
  if (!proposals.some((proposal) => proposal.reasons.includes("amount_equal")) && receipt.direction === "purchase") {
    const parts = eligible.filter((candidate) => (merchantSimilarity(receipt.merchant, candidate.description) ?? 0) >= 0.8
      && (!receipt.currency || !candidate.currency || receipt.currency === candidate.currency) && Math.abs(candidate.amountMinor) < receipt.amountMinor);
    for (let i = 0; i < parts.length; i += 1) {
      for (let j = i + 1; j < parts.length; j += 1) {
        if (Math.abs(parts[i].amountMinor) + Math.abs(parts[j].amountMinor) !== receipt.amountMinor) continue;
        const offset = Math.max(dayNumber(parts[i].date), dayNumber(parts[j].date)) - receiptDay;
        proposals.push({ level: "ambiguous", ids: [parts[i].id, parts[j].id], score: 60 + Math.max(0, 20 - 3 * Math.max(0, offset)), reasons: ["split_payment", "merchant_similar"], dayOffset: offset });
      }
    }
  }

  proposals.sort(compareProposals);
  const strong = proposals.filter((proposal) => proposal.level === "exact" || proposal.level === "probable");
  if (strong.length >= 2) {
    // Two equally plausible entries (two $4.50 coffees): a person picks.
    for (const proposal of strong) {
      proposal.level = "ambiguous";
      if (!proposal.reasons.includes("multiple_candidates")) proposal.reasons.push("multiple_candidates");
    }
  } else if (strong.length === 1 && strong[0].level === "exact") {
    const rivals = proposals.filter((proposal) => proposal !== strong[0] && proposal.reasons.includes("amount_equal") && !proposal.reasons.includes("merchant_unknown"));
    if (rivals.length > 0 && !strong[0].reasons.includes("receipt_number_match")) {
      strong[0].level = "probable";
      strong[0].reasons.push("similar_candidates");
    }
  }
  const rank: Record<MatchProposal["level"], number> = { exact: 0, probable: 1, ambiguous: 2 };
  proposals.sort((a, b) => rank[a.level] - rank[b.level] || compareProposals(a, b));
  const best = proposals[0] ?? null;
  return { level: best ? best.level : "none", best, proposals };
}

// ---------------------------------------------------------------- receipt ↔ receipt

export interface ReceiptForDuplicate {
  id: string | number;
  sha256?: string | null;
  amountMinor: number | null;
  date: string | null;
  time?: string | null;
  merchant: string | null;
  receiptNumber?: string | null;
  direction?: "purchase" | "refund";
}

export type ReceiptDuplicateKind = "same_file" | "same_receipt" | "possible";

export interface ReceiptDuplicate {
  kind: ReceiptDuplicateKind;
  of: string | number;
}

/**
 * Whether an incoming receipt is one already captured: the same file (same_file), the same
 * receipt number at the same merchant (same_receipt), or a re-photographed/cropped copy that reads
 * the same merchant, date and total (possible — a person decides, since two identical purchases
 * on one day are real). Receipt numbers that differ prove two receipts.
 */
export function findDuplicateReceipt(incoming: ReceiptForDuplicate, existing: ReadonlyArray<ReceiptForDuplicate>): ReceiptDuplicate | null {
  if (incoming.sha256) {
    const same = existing.find((receipt) => receipt.sha256 && receipt.sha256 === incoming.sha256);
    if (same) return { kind: "same_file", of: same.id };
  }
  const number = normalizeId(incoming.receiptNumber);
  let possible: ReceiptForDuplicate | null = null;
  for (const receipt of existing) {
    if (receipt.id === incoming.id) continue;
    if ((receipt.direction ?? "purchase") !== (incoming.direction ?? "purchase")) continue;
    const similarity = merchantSimilarity(incoming.merchant, receipt.merchant);
    const otherNumber = normalizeId(receipt.receiptNumber);
    if (number.length >= 4 && otherNumber.length >= 4) {
      if (number === otherNumber && (similarity === null || similarity >= 0.8) && (incoming.amountMinor === null || receipt.amountMinor === null || incoming.amountMinor === receipt.amountMinor)) {
        return { kind: "same_receipt", of: receipt.id };
      }
      continue;
    }
    if (incoming.amountMinor === null || incoming.date === null || incoming.amountMinor !== receipt.amountMinor || incoming.date !== receipt.date) continue;
    if (similarity === null || similarity < 0.8) continue;
    if (incoming.time && receipt.time && incoming.time !== receipt.time) continue;
    possible ??= receipt;
  }
  return possible ? { kind: "possible", of: possible.id } : null;
}
