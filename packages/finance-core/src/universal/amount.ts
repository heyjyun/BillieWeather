// Amount text in the formats banks actually print, parsed exactly:
//   "1,234.56"  "1.234,56"  "1 234,56"  "1'234.56"  "1,23,456.00"  "-12.30"  "12.30-"  "(12.30)"
//   "12.30 CR"  "DR 12.30"  "$12.30"  "US$12.30"  "€ 12,30"  "12,30 €"  "¥1,000"  "１２３"  "−12.30"
// The decimal separator is a per-column convention. When a column gives no evidence and a
// value like "1,234" could mean either 1234 or 1.234, detection reports it as ambiguous and
// the person has to choose: the value is never silently guessed.
import { decimalToMinor, type DecimalProblem } from "./currency";

export type DecimalSeparator = "." | ",";

export interface AmountParse {
  minor: number;
  /** A currency the text itself names ("$", "€", "EUR"), upper-case ISO code or symbol. */
  currencyHint: string | null;
  /** The text had an explicit sign (minus, plus, parentheses) or debit/credit marker. */
  explicitSign: "negative" | "positive" | null;
  /** A CR/DR marker fixed the direction; it is absolute and not affected by a file's sign convention. */
  absolute: boolean;
}

export type AmountProblem = "empty" | DecimalProblem;

/** Symbols, longest first, with the ISO codes they may stand for. */
const SYMBOLS: Array<[string, string[]]> = [
  ["US$", ["USD"]], ["CA$", ["CAD"]], ["C$", ["CAD"]], ["A$", ["AUD"]], ["AU$", ["AUD"]], ["NZ$", ["NZD"]], ["HK$", ["HKD"]], ["S$", ["SGD"]],
  ["NT$", ["TWD"]], ["MOP$", ["MOP"]], ["R$", ["BRL"]], ["RMB", ["CNY"]], ["CN¥", ["CNY"]], ["JP¥", ["JPY"]], ["CHF", ["CHF"]],
  ["$", ["USD", "CAD", "AUD", "NZD", "HKD", "SGD", "TWD", "MXN"]], ["€", ["EUR"]], ["£", ["GBP"]], ["¥", ["JPY", "CNY"]], ["￥", ["JPY", "CNY"]],
  ["元", ["CNY", "TWD", "HKD"]], ["円", ["JPY"]], ["₩", ["KRW"]], ["원", ["KRW"]], ["₹", ["INR"]], ["₽", ["RUB"]], ["₺", ["TRY"]], ["₫", ["VND"]],
  ["₱", ["PHP"]], ["฿", ["THB"]], ["zł", ["PLN"]], ["kr", ["SEK", "NOK", "DKK", "ISK"]], ["Fr.", ["CHF"]],
];

const SPACES = /[\s   ]/g;

/** Currencies a symbol could mean; ISO codes stand for themselves. */
export function currenciesForHint(hint: string): string[] {
  if (/^[A-Z]{3}$/.test(hint)) return [hint];
  return SYMBOLS.find(([symbol]) => symbol === hint)?.[1] ?? [];
}

interface Stripped {
  number: string;
  currencyHint: string | null;
  sign: "negative" | "positive" | null;
  marker: "cr" | "dr" | null;
}

/** Removes signs, debit/credit markers and currency marks; returns the bare number text. */
function strip(raw: string): Stripped | null {
  let text = raw.normalize("NFKC").replace(/[−‒–﹣－]/g, "-").trim();
  if (text === "") return null;
  let negative = false;
  let positive = false;
  let marked: "cr" | "dr" | null = null;
  let currencyHint: string | null = null;
  const takeCurrency = () => {
    for (const [symbol] of SYMBOLS) {
      if (text.startsWith(symbol)) {
        currencyHint ??= symbol;
        text = text.slice(symbol.length).trim();
        return true;
      }
      if (text.endsWith(symbol)) {
        currencyHint ??= symbol;
        text = text.slice(0, -symbol.length).trim();
        return true;
      }
    }
    // No lookbehind: Safari 15 WebViews cannot parse it.
    const prefix = /^([A-Z]{3})\s*(?=[\d(+-])/.exec(text);
    if (prefix) {
      currencyHint ??= prefix[1];
      text = text.slice(prefix[0].length).trim();
      return true;
    }
    const suffix = /[\d)]\s*([A-Z]{3})$/.exec(text);
    if (suffix && !/^(CR|DR)$/.test(suffix[1])) {
      currencyHint ??= suffix[1];
      text = text.slice(0, text.length - suffix[0].length + 1).trim();
      return true;
    }
    return false;
  };
  for (let guard = 0; guard < 6; guard += 1) {
    const before = text;
    if (/^\(.*\)$/.test(text)) {
      negative = true;
      text = text.slice(1, -1).trim();
    }
    const marker = /^(CR|DR|Cr|Dr|cr|dr)\.?\s+|\s*(CR|DR|Cr|Dr|cr|dr)\.?$/.exec(text);
    if (marker) {
      const found = (marker[1] ?? marker[2]).toLowerCase() as "cr" | "dr";
      if (marked && marked !== found) return { number: "", currencyHint, sign: null, marker: null };
      marked = found;
      text = (marker.index === 0 ? text.slice(marker[0].length) : text.slice(0, marker.index)).trim();
    }
    if (text.startsWith("-")) {
      negative = true;
      text = text.slice(1).trim();
    } else if (text.startsWith("+")) {
      positive = true;
      text = text.slice(1).trim();
    } else if (text.endsWith("-")) {
      negative = true;
      text = text.slice(0, -1).trim();
    } else if (text.endsWith("+")) {
      positive = true;
      text = text.slice(0, -1).trim();
    }
    takeCurrency();
    if (text === before) break;
  }
  const sign = negative ? "negative" : positive ? "positive" : null;
  // "-12.30 CR" contradicts itself; "-12.30 DR" is merely redundant.
  if ((negative && positive) || (marked === "cr" && negative) || (marked === "dr" && positive)) return { number: "", currencyHint, sign: null, marker: null };
  return { number: text, currencyHint, sign, marker: marked };
}

/** Grouped integer part like 1,234,567 / 1.234.567 / 1 234 567 / 1'234'567 / 12,34,567 (Indian). */
function ungroup(integer: string, group: string): string | null {
  if (/^\d+$/.test(integer)) return integer;
  const parts = integer.split(group);
  if (parts.length < 2 || parts.some((part) => !/^\d+$/.test(part))) return null;
  const [first, ...rest] = parts;
  const last = rest[rest.length - 1];
  if (first.length < 1 || first.length > 3 || last.length !== 3) return null;
  const middle = rest.slice(0, -1);
  const western = middle.every((part) => part.length === 3);
  const indian = group === "," && middle.every((part) => part.length === 2) && first.length <= 2;
  return western || indian ? parts.join("") : null;
}

const GROUPS: Record<DecimalSeparator, string[]> = { ".": [",", " ", "'", "’"], ",": [".", " ", "'", "’"] };

/** Parses one amount with a known decimal separator. */
export function parseAmount(raw: string, decimal: DecimalSeparator, exponent: number): { ok: true; value: AmountParse } | { ok: false; problem: AmountProblem } {
  const stripped = strip(raw);
  if (!stripped) return { ok: false, problem: "empty" };
  const text = stripped.number.replace(SPACES, " ");
  if (text === "") return { ok: false, problem: "unreadable" };
  const decimalAt = text.lastIndexOf(decimal);
  let integer = decimalAt >= 0 ? text.slice(0, decimalAt) : text;
  const fraction = decimalAt >= 0 ? text.slice(decimalAt + 1) : "";
  if (decimalAt >= 0 && !/^\d+$/.test(fraction)) return { ok: false, problem: "unreadable" };
  if (integer === "") integer = "0";
  let digits: string | null = null;
  for (const group of GROUPS[decimal]) {
    digits = ungroup(integer, group);
    if (digits !== null) break;
  }
  if (digits === null) return { ok: false, problem: "unreadable" };
  const negative = stripped.sign === "negative" || stripped.marker === "dr";
  const result = decimalToMinor(`${negative ? "-" : ""}${digits}${fraction ? `.${fraction}` : ""}`, exponent);
  if (!result.ok) return result;
  const explicitSign = negative ? "negative" : stripped.sign === "positive" || stripped.marker === "cr" ? "positive" : null;
  return { ok: true, value: { minor: result.minor, currencyHint: stripped.currencyHint, explicitSign, absolute: stripped.marker !== null } };
}

export interface DecimalDetection {
  /** The separator the column's values prove, or null when they prove nothing. */
  decimal: DecimalSeparator | null;
  /** Some value would change meaning with the other separator and nothing settles it. */
  ambiguous: boolean;
  /** Values prove contradictory separators. */
  conflict: boolean;
}

/** Looks at every value in a column. Exponent 0 currencies (JPY, KRW) have no decimals, so "1,234" is grouping. */
export function detectDecimalSeparator(values: readonly string[], exponent: number): DecimalDetection {
  const evidence = new Set<DecimalSeparator>();
  let ambiguous = false;
  for (const raw of values) {
    const stripped = strip(raw);
    if (!stripped) continue;
    const text = stripped.number.replace(SPACES, "");
    const dots = (text.match(/\./g) ?? []).length;
    const commas = (text.match(/,/g) ?? []).length;
    if (dots > 0 && commas > 0) {
      evidence.add(text.lastIndexOf(".") > text.lastIndexOf(",") ? "." : ",");
    } else if (dots > 1) {
      evidence.add(",");
    } else if (commas > 1) {
      evidence.add(".");
    } else if (dots === 1 || commas === 1) {
      const separator: DecimalSeparator = dots === 1 ? "." : ",";
      const after = text.length - text.indexOf(separator) - 1;
      if (after === 3 && /^\d{1,3}[.,]\d{3}$/.test(text)) {
        if (exponent === 0) evidence.add(separator === "." ? "," : ".");
        else if (exponent !== 3) ambiguous = true;
        else evidence.add(separator);
      } else {
        evidence.add(separator);
      }
    }
  }
  if (evidence.size > 1) return { decimal: null, ambiguous: false, conflict: true };
  const [decimal = null] = [...evidence];
  return { decimal, ambiguous: decimal === null && ambiguous, conflict: false };
}
