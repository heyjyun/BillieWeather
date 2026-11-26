// Port of app/services/finance/categorizer.rb. Keep the lists and their ORDER in sync:
// the first matching category wins. Parity is checked against Ruby-generated
// fixtures in ../fixtures (see fixtures/README.md).
import { inferKind, type AccountType } from "./ledger/domain";
import type { Category, MerchantRule } from "@billie/shared-types";
import { resolveDefaultKey, type CategoryTree } from "./categoryTree";
import { normalizeRegion, regionalCategoryKey, type StatementRegion } from "./regions";
import { UNCATEGORIZED } from "./taxonomy";

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

/**
 * The keyword lists, by default-category key (schema/default-categories.json). Keys are resolved to the
 * person's own names (CategoryTree.resolveKey), so a renamed or moved default keeps receiving matches.
 * Null means "decided: Uncategorized".
 */
export const KEYWORD_RULES: ReadonlyArray<readonly [string | null, RegExp]> = [
  ["housing", words("rent", "mortgage", "property management", "hoa", "landlord", "apartment", "lease", "home insurance", "renters insurance", "homeowners")],
  ["food", words("grocery", "groceries", "supermarket", "restaurant", "coffee", "cafe", "dining", "whole foods", "trader joe", "starbucks",
    "kroger", "safeway", "aldi", "publix", "wegmans", "costco wholesale", "mcdonald", "burger king", "wendy", "taco bell", "chipotle", "domino", "pizza",
    "kfc", "dunkin", "panera", "doordash", "grubhub", "uber eats", "ubereats", "instacart", "bakery", "bistro", "diner", "sushi", "deli", "boba", "bar & grill",
    "7-eleven", "food", "kitchen", "tea house", "noodle", "ramen", "taqueria")],
  ["transport", words("uber", "lyft", "transit", "metro", "parking", "fuel", "gas station", "shell", "exxon", "chevron", "bp", "mobil", "ventra", "cta", "mta",
    "amtrak", "airlines", "airways", "airline", "southwest", "jetblue", "toll", "ezpass", "e-zpass", "zipcar", "car wash", "auto repair", "dmv", "greyhound", "bus")],
  ["utilities", words("electric", "electricity", "water bill", "internet", "utility", "utilities", "comcast", "verizon", "at&t", "phone bill",
    "xfinity", "spectrum", "t-mobile", "tmobile", "sewer", "waste management", "trash", "natural gas", "gas bill", "comed", "pg&e", "wireless", "cable")],
  ["health", words("pharmacy", "medical", "doctor", "hospital", "dental", "cvs", "walgreens", "rite aid", "clinic", "urgent care", "optical", "vision",
    "therapy", "labcorp", "quest diagnostics", "health insurance", "gym", "fitness", "yoga", "planet fitness", "dentist", "physician")],
  ["business", words("office supplies", "software", "adobe", "notion", "github", "hosting", "business insurance")],
  // Matched before Shopping so an AWS bill is not filed as Amazon shopping.
  [null, words("aws", "amazon web services")],
  ["shopping", words("amazon", "target", "walmart", "shopping", "clothing", "apparel", "ebay", "etsy", "best buy", "home depot", "lowe's", "ikea", "nike",
    "adidas", "zara", "h&m", "uniqlo", "macy", "nordstrom", "costco", "apple store", "apple.com", "store", "mart", "outlet", "boutique")],
];

/** The keyword lists with the default names (older callers and the Ruby fixtures). */
export const RULES: ReadonlyArray<readonly [Category, RegExp]> = KEYWORD_RULES.map(([key, pattern]) => [key ? resolveDefaultKey(key) : UNCATEGORIZED, pattern] as const);

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

export interface CategorizerOptions {
  /** The statement's optional country/region (regions.ts). */
  region?: string | null;
  /** The person's categories: keys resolve to their current names (else the defaults' names). */
  tree?: CategoryTree | null;
}

export class Categorizer {
  private learned: Map<string, Category>;
  /** The statement's optional country/region (regions.ts), or null when not specified. */
  readonly region: StatementRegion | null;
  private tree: CategoryTree | null;

  constructor(rules: readonly MerchantRule[] = [], options: CategorizerOptions = {}) {
    this.learned = new Map(rules.map((rule) => [ruleKey(rule.merchantKey, rule.income), rule.category]));
    this.region = normalizeRegion(options.region);
    this.tree = options.tree ?? null;
  }

  /** A default's key as the person's category name (parent key, then Uncategorized, when it was deleted). */
  resolve(key: string | null): Category {
    if (!key) return UNCATEGORIZED;
    return this.tree ? this.tree.resolveKey(key) : resolveDefaultKey(key);
  }

  categorize(description: string, amountCents: number, accountType: AccountType | null = null): Category {
    return this.explain(description, amountCents, accountType).category;
  }

  /**
   * The category and the step that chose it. The order is the Rails order; the region is a last,
   * supplementary step, so without a region (or with one that has no rules) results are unchanged.
   * `key` is the default's key the keyword step matched (null for learned rules and Uncategorized).
   */
  explain(description: string, amountCents: number, accountType: AccountType | null = null): { category: Category; reason: CategoryReason; key: string | null } {
    const key = merchantKey(description);
    const learned = key ? this.learned.get(ruleKey(key, amountCents > 0)) : undefined;
    if (learned) return { category: learned, reason: "learned", key: null };
    const decided = (systemKey: string | null, reason: CategoryReason) => ({ category: this.resolve(systemKey), reason, key: systemKey });
    if (TRANSFERS.test(description)) return decided("transfers", "transfer");
    if (amountCents > 0) {
      // Money in is Income only when it is income: a refund keeps an expense category (it reduces
      // spending there) and a card repayment is a transfer (financial-schema.json kind_inference).
      const kind = inferKind({ amountMinor: amountCents, accountType, description });
      if (kind === "income") return decided("income", "income");
      if (kind === "card_payment" || kind === "transfer") return decided("transfers", "transfer");
    }
    const rule = KEYWORD_RULES.find(([, pattern]) => pattern.test(description));
    // "Uncategorized" is itself a rule (AWS): a deliberate decision the region must not override.
    if (rule) return decided(rule[0], "rule");
    const regional = regionalCategoryKey(this.region, description);
    return regional ? decided(regional, "region") : { category: UNCATEGORIZED, reason: "none", key: null };
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
