// Port of app/services/finance/categorizer.rb. Keep the lists and their ORDER in sync:
// the first matching category wins. Parity is checked against Ruby-generated
// fixtures in ../fixtures (see fixtures/README.md).
import type { Category, MerchantRule } from "@billie/shared-types";
import { normalizeRegion, regionalCategory, type StatementRegion } from "./regions";

// Ruby's \b is Unicode-aware on UTF-8 strings ("é" is a word character); JavaScript's
// \b is ASCII-only, so word boundaries are spelled out with Unicode classes instead.
const WORD_CHAR = "[\\p{L}\\p{M}\\p{Nd}\\p{Pc}]";

const escape = (word: string) => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function words(...list: string[]): RegExp {
  return new RegExp(`(?<!${WORD_CHAR})(?:${list.map(escape).join("|")})(?!${WORD_CHAR})`, "iu");
}

/** Like `words`, but a phrase's words may be separated by spaces and punctuation ("PAYMENT - THANK YOU"). */
const PHRASE_GAP = "[\\s.,;:/_*#·\\-–—]+"; // same set as categorizer.rb

function phrases(...list: string[]): RegExp {
  const joined = list.map((phrase) => phrase.split(" ").map(escape).join(PHRASE_GAP));
  return new RegExp(`(?<!${WORD_CHAR})(?:${joined.join("|")})(?!${WORD_CHAR})`, "iu");
}

/** Left out of income/spending totals; kept narrow on purpose. */
export const TRANSFERS = phrases("transfer", "payment thank you", "credit card payment", "opening balance", "balance forward");

export const RULES: ReadonlyArray<readonly [Category, RegExp]> = [
  ["Housing", words("rent", "mortgage", "property management", "hoa", "landlord", "apartment", "lease", "home insurance", "renters insurance", "homeowners")],
  ["Food & dining", words("grocery", "groceries", "supermarket", "restaurant", "coffee", "cafe", "dining", "whole foods", "trader joe", "starbucks",
    "kroger", "safeway", "aldi", "publix", "wegmans", "costco wholesale", "mcdonald", "burger king", "wendy", "taco bell", "chipotle", "domino", "pizza",
    "kfc", "dunkin", "panera", "doordash", "grubhub", "uber eats", "ubereats", "instacart", "bakery", "bistro", "diner", "sushi", "deli", "boba", "bar & grill",
    "7-eleven", "food", "kitchen", "tea house", "noodle", "ramen", "taqueria")],
  ["Transport", words("uber", "lyft", "transit", "metro", "parking", "fuel", "gas station", "shell", "exxon", "chevron", "bp", "mobil", "ventra", "cta", "mta",
    "amtrak", "airlines", "airways", "airline", "southwest", "jetblue", "toll", "ezpass", "e-zpass", "zipcar", "car wash", "auto repair", "dmv", "greyhound", "bus")],
  ["Utilities", words("electric", "electricity", "water bill", "internet", "utility", "utilities", "comcast", "verizon", "at&t", "phone bill",
    "xfinity", "spectrum", "t-mobile", "tmobile", "sewer", "waste management", "trash", "natural gas", "gas bill", "comed", "pg&e", "wireless", "cable")],
  ["Health", words("pharmacy", "medical", "doctor", "hospital", "dental", "cvs", "walgreens", "rite aid", "clinic", "urgent care", "optical", "vision",
    "therapy", "labcorp", "quest diagnostics", "health insurance", "gym", "fitness", "yoga", "planet fitness", "dentist", "physician")],
  ["Business", words("office supplies", "software", "adobe", "notion", "github", "hosting", "business insurance")],
  // Matched before Shopping so an AWS bill is not filed as Amazon shopping.
  ["Uncategorized", words("aws", "amazon web services")],
  ["Shopping", words("amazon", "target", "walmart", "shopping", "clothing", "apparel", "ebay", "etsy", "best buy", "home depot", "lowe's", "ikea", "nike",
    "adidas", "zara", "h&m", "uniqlo", "macy", "nordstrom", "costco", "apple store", "apple.com", "store", "mart", "outlet", "boutique")],
];

const NOISE_WORDS = new Set(("pos purchase debit credit card checkcard visa mastercard ach web online payment pmt recurring withdrawal deposit sq tst pp " +
  "www com inc llc ltd co the and of at in on").split(" "));

// Ruby's \s and String#split use ASCII whitespace only.
const ASCII_SPACE = "[ \\t\\r\\n\\f\\v]";
const NON_MERCHANT = new RegExp(`[^\\p{L}&${ASCII_SPACE.slice(1, -1)}]`, "gu");
const SPLIT = new RegExp(`${ASCII_SPACE}+`);

const charLength = (text: string) => [...text].length;

/**
 * A short, stable name for a merchant: letters only, noise removed, first two words.
 * "STARBUCKS STORE #1234 SEATTLE WA" and "Starbucks Store 99 Portland OR" share "starbucks store".
 */
export function merchantKey(description: string): string | null {
  const tokens = description.toLowerCase().replace(NON_MERCHANT, " ").split(SPLIT)
    .filter((token) => token !== "" && !NOISE_WORDS.has(token) && charLength(token) >= 2);
  const key = tokens.slice(0, 2).join(" ");
  return key !== "" && (charLength(key) >= 3 || /[^\x00-\x7F]/.test(key)) ? key : null;
}

const ruleKey = (merchant: string, income: boolean) => `${income ? "in" : "out"}:${merchant}`;

/** Which step decided a category. "region" means only the statement's optional region matched. */
export type CategoryReason = "learned" | "transfer" | "income" | "rule" | "region" | "none";

export class Categorizer {
  private learned: Map<string, Category>;
  /** The statement's optional country/region (regions.ts), or null when not specified. */
  readonly region: StatementRegion | null;

  constructor(rules: readonly MerchantRule[] = [], options: { region?: string | null } = {}) {
    this.learned = new Map(rules.map((rule) => [ruleKey(rule.merchantKey, rule.income), rule.category]));
    this.region = normalizeRegion(options.region);
  }

  categorize(description: string, amountCents: number): Category {
    return this.explain(description, amountCents).category;
  }

  /**
   * The category and the step that chose it. The order is the Rails order; the region is a last,
   * supplementary step, so without a region (or with one that has no rules) results are unchanged.
   */
  explain(description: string, amountCents: number): { category: Category; reason: CategoryReason } {
    const key = merchantKey(description);
    const learned = key ? this.learned.get(ruleKey(key, amountCents > 0)) : undefined;
    if (learned) return { category: learned, reason: "learned" };
    if (TRANSFERS.test(description)) return { category: "Transfers", reason: "transfer" };
    if (amountCents > 0) return { category: "Income", reason: "income" };
    const rule = RULES.find(([, pattern]) => pattern.test(description));
    // "Uncategorized" is itself a rule (AWS): a deliberate decision the region must not override.
    if (rule) return { category: rule[0], reason: "rule" };
    const regional = regionalCategory(this.region, description);
    return regional ? { category: regional, reason: "region" } : { category: "Uncategorized", reason: "none" };
  }
}

/** Rails ActiveSupport#titleize for merchant keys (lowercase letters, spaces, &). */
export function titleizeMerchant(key: string | null): string | null {
  if (key === null) return null;
  // Ruby: /\b(?<!\w['’`()])[a-z]/ with a Unicode-aware \b.
  const pattern = new RegExp(`(?<!${WORD_CHAR})(?<!${WORD_CHAR}['’\`()])[a-z]`, "gu");
  const titled = key.replace(pattern, (letter) => letter.toUpperCase());
  // humanize: a leading word character is upcased too, accented ones included.
  return titled.replace(new RegExp(`^${WORD_CHAR}`, "u"), (first) => first.toUpperCase());
}
