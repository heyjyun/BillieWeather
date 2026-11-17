// Merchant identity: whether a receipt's "Whole Foods Market" and a bank's "WHOLEFDS MKT #10234"
// name the same business. Shared with Rails (app/services/finance/merchant_identity.rb); both read
// schema/merchant-aliases.json and replay fixtures/receipts/merchant-cases.json.
//
// Identity is evidence for matching, never proof on its own: the matcher also needs the amount and
// the date to agree (match.ts).
import aliases from "../../schema/merchant-aliases.json";

const PREFIXES = [...aliases.prefixes].sort((a, b) => b.length - a.length);
const NOISE = new Set(aliases.noise);
const GENERIC = new Set(aliases.generic);
const ALIASES: Array<[string, string]> = Object.entries(aliases.aliases)
  .flatMap(([canonical, phrases]) => phrases.map((phrase) => [phrase, canonical] as [string, string]))
  .sort((a, b) => b[0].length - a[0].length || a[0].localeCompare(b[0]));

export interface MerchantIdentity {
  /** Normalized key ("whole foods"), or null when the text has no usable letters. */
  key: string | null;
  /** True when an alias in merchant-aliases.json produced the key. */
  known: boolean;
}

/** Lowercase letters (any script) separated by single spaces. Digits, punctuation and symbols go. */
function letters(text: string): string {
  return text
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/['’`]/g, "")
    .replace(/[^\p{L}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

/** Removes payment-processor and POS prefixes: "SQ *BLUE BOTTLE" → "blue bottle". */
function stripPrefixes(raw: string): string {
  let text = raw.normalize("NFKC").toLowerCase().trim();
  // "SQ *NAME", "TST* NAME", "PAYPAL *NAME": a short processor code before a star.
  const starred = text.match(/^([a-z]{1,8})\s?\*\s?(.+)$/);
  if (starred && PREFIXES.includes(starred[1])) text = starred[2];
  let normalized = letters(text);
  for (let changed = true; changed; ) {
    changed = false;
    for (const prefix of PREFIXES) {
      // Prefixes without a star must be whole words and leave something behind ("pos purchase target").
      if (prefix.length >= 3 && normalized.startsWith(`${prefix} `) && normalized.length > prefix.length + 2) {
        normalized = normalized.slice(prefix.length + 1);
        changed = true;
        break;
      }
    }
  }
  return normalized;
}

export function merchantIdentity(text: string | null | undefined): MerchantIdentity {
  if (!text) return { key: null, known: false };
  const normalized = stripPrefixes(text);
  if (normalized === "") return { key: null, known: false };
  const compactText = normalized.replace(/ /g, "");
  for (const [phrase, canonical] of ALIASES) {
    if (normalized === phrase || normalized.startsWith(`${phrase} `)) return { key: canonical, known: true };
    // Bank descriptors run the words of a multi-word name together: "traderjoes", "wholefoods".
    const compactPhrase = phrase.replace(/ /g, "");
    if (phrase.includes(" ") && compactText.startsWith(compactPhrase) && normalized.split(" ")[0].startsWith(compactPhrase)) return { key: canonical, known: true };
  }
  const tokens = normalized.split(" ").filter((token) => !NOISE.has(token) && (token.length >= 2 || /[^\x00-\x7F]/.test(token)));
  if (tokens.length === 0) return { key: null, known: false };
  // Trailing two-letter tokens are usually a state or country code ("austin tx").
  while (tokens.length > 1 && tokens[tokens.length - 1].length === 2 && /^[a-z]{2}$/.test(tokens[tokens.length - 1])) tokens.pop();
  return { key: tokens.slice(0, 3).join(" "), known: false };
}

/** Consonant outline used for bank abbreviations: "wholefoods" and "wholefds" → "whlfds". */
function skeleton(compact: string): string {
  return compact.replace(/[aeiou]/g, "").replace(/(.)\1+/g, "$1");
}

function bigrams(text: string): string[] {
  const chars = Array.from(text);
  const grams: string[] = [];
  for (let index = 0; index < chars.length - 1; index += 1) grams.push(chars[index] + chars[index + 1]);
  return grams;
}

function dice(a: string, b: string): number {
  const left = bigrams(a);
  const right = bigrams(b);
  if (left.length === 0 || right.length === 0) return a === b ? 1 : 0;
  const counts = new Map<string, number>();
  for (const gram of left) counts.set(gram, (counts.get(gram) ?? 0) + 1);
  let overlap = 0;
  for (const gram of right) {
    const count = counts.get(gram) ?? 0;
    if (count > 0) {
      overlap += 1;
      counts.set(gram, count - 1);
    }
  }
  return (2 * overlap) / (left.length + right.length);
}

const round2 = (value: number) => Math.round(value * 100) / 100;

/**
 * 0..1 similarity of two merchant names, or null when either has no identity (unknown, not different).
 * 1 = same identity; ≥ 0.8 = the same business written differently; < 0.3 = clearly different.
 */
export function merchantSimilarity(a: string | null | undefined, b: string | null | undefined): number | null {
  const left = merchantIdentity(a).key;
  const right = merchantIdentity(b).key;
  if (left === null || right === null) return null;
  if (left === right) return 1;
  const compactLeft = left.replace(/ /g, "");
  const compactRight = right.replace(/ /g, "");
  if (compactLeft === compactRight) return 0.95;
  const [shorter, longer] = compactLeft.length <= compactRight.length ? [compactLeft, compactRight] : [compactRight, compactLeft];
  let score = round2(dice(compactLeft, compactRight) * 0.9);
  if (shorter.length >= 5 && longer.startsWith(shorter)) score = Math.max(score, 0.85);
  const firstLeft = left.split(" ")[0];
  const firstRight = right.split(" ")[0];
  if (firstLeft === firstRight && firstLeft.length >= 4 && !GENERIC.has(firstLeft)) score = Math.max(score, 0.85);
  const outlineLeft = skeleton(compactLeft);
  const outlineRight = skeleton(compactRight);
  if (outlineLeft.length >= 4 && outlineLeft === outlineRight) score = Math.max(score, 0.8);
  return round2(Math.min(score, 0.95));
}
