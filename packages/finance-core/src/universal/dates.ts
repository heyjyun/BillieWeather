// Transaction dates in the formats banks print. Year-first and month-name dates are
// unambiguous. For numeric day/month dates ("03/04/2026") the order is a per-column
// convention: it is proven by a value with a part above 12, or the person chooses it.
// Nothing here guesses from the interface language.
import type { IsoDate } from "@billie/shared-types";

export type DateOrder = "ymd" | "dmy" | "mdy";

export type DateProblem = "empty" | "unreadable" | "invalid" | "ambiguous" | "out_of_range";

const MONTHS: Record<string, number> = {};
const MONTH_NAMES: Array<[number, string[]]> = [
  [1, ["jan", "january", "janv", "janvier", "ene", "enero", "januar", "jän"]],
  [2, ["feb", "february", "févr", "fevr", "février", "febrero", "februar"]],
  [3, ["mar", "march", "mars", "marzo", "mär", "märz", "maerz"]],
  [4, ["apr", "april", "avr", "avril", "abr", "abril"]],
  [5, ["may", "mai", "mayo"]],
  [6, ["jun", "june", "juin", "junio", "juni"]],
  [7, ["jul", "july", "juil", "juillet", "julio", "juli"]],
  [8, ["aug", "august", "août", "aout", "ago", "agosto"]],
  [9, ["sep", "sept", "september", "septembre", "septiembre"]],
  [10, ["oct", "october", "octobre", "octubre", "okt", "oktober"]],
  [11, ["nov", "november", "novembre", "noviembre"]],
  [12, ["dec", "december", "déc", "decembre", "décembre", "dic", "diciembre", "dez", "dezember"]],
];
for (const [month, names] of MONTH_NAMES) for (const name of names) MONTHS[name] = month;

export const MIN_YEAR = 1900;
export const MAX_YEAR = 2100;

function iso(year: number, month: number, day: number): { ok: true; iso: IsoDate } | { ok: false; problem: DateProblem } {
  if (year < MIN_YEAR || year > MAX_YEAR) return { ok: false, problem: "out_of_range" };
  const date = new Date(Date.UTC(year, month - 1, day));
  if (month < 1 || month > 12 || date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    return { ok: false, problem: "invalid" };
  }
  return { ok: true, iso: `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}` };
}

type Shape =
  | { kind: "exact"; year: number; month: number; day: number }
  /** a/b/year where a and b are day and month in an unknown order. */
  | { kind: "pair"; a: number; b: number; year: number; twoDigitYear: boolean };

/** Splits a date into parts without deciding day/month order. Times after the date are ignored. */
function shape(raw: string): Shape | null {
  let text = raw.normalize("NFKC").trim();
  // Drop a trailing time: "2026-03-04 12:30", "2026-03-04T12:30:00Z", "04/03/2026 9:15 AM".
  text = text.replace(/[T\s]+\d{1,2}:\d{2}(?::\d{2}(?:\.\d+)?)?\s*(?:[AaPp][Mm])?\s*(?:Z|[+-]\d{2}:?\d{2})?$/, "").trim();
  let match = /^(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日?$/.exec(text) ?? /^(\d{4})\s*년\s*(\d{1,2})\s*월\s*(\d{1,2})\s*일?$/.exec(text);
  if (match) return { kind: "exact", year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
  match = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/.exec(text);
  if (match) return { kind: "exact", year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
  match = /^(\d{4})(\d{2})(\d{2})$/.exec(text);
  if (match) return { kind: "exact", year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
  match = /^(\d{1,2})[-/.\s](\d{1,2})[-/.\s](\d{4}|\d{2})$/.exec(text);
  if (match) {
    const twoDigitYear = match[3].length === 2;
    return { kind: "pair", a: Number(match[1]), b: Number(match[2]), year: twoDigitYear ? 2000 + Number(match[3]) : Number(match[3]), twoDigitYear };
  }
  // Month names: "04 Mar 2026", "4-Mar-26", "Mar 4, 2026", "March 4 2026", "4. März 2026".
  const words = text.toLowerCase().replace(/[,]/g, " ").replace(/(\d)\.(?=\s)/g, "$1").split(/[\s\-/.]+/).filter(Boolean);
  if (words.length === 3) {
    const [x, y, z] = words;
    const year = (value: string) => (/^\d{4}$/.test(value) ? Number(value) : /^\d{2}$/.test(value) ? 2000 + Number(value) : null);
    const day = (value: string) => (/^\d{1,2}$/.test(value) ? Number(value) : null);
    if (MONTHS[y] && day(x) !== null && year(z) !== null) return { kind: "exact", year: year(z)!, month: MONTHS[y], day: day(x)! };
    if (MONTHS[x] && day(y) !== null && year(z) !== null) return { kind: "exact", year: year(z)!, month: MONTHS[x], day: day(y)! };
    if (/^\d{4}$/.test(x) && MONTHS[y] && day(z) !== null) return { kind: "exact", year: Number(x), month: MONTHS[y], day: day(z)! };
  }
  return null;
}

/** Parses one date. `order` is needed only for numeric day/month dates. */
export function parseDate(raw: string, order: DateOrder | null): { ok: true; iso: IsoDate } | { ok: false; problem: DateProblem } {
  if (raw.trim() === "") return { ok: false, problem: "empty" };
  const parts = shape(raw);
  if (!parts) return { ok: false, problem: "unreadable" };
  if (parts.kind === "exact") return iso(parts.year, parts.month, parts.day);
  if (order === "dmy") return iso(parts.year, parts.b, parts.a);
  if (order === "mdy") return iso(parts.year, parts.a, parts.b);
  // Without a convention, only a value whose order is self-evident can be read.
  if (parts.a > 12 && parts.b <= 12) return iso(parts.year, parts.b, parts.a);
  if (parts.b > 12 && parts.a <= 12) return iso(parts.year, parts.a, parts.b);
  if (parts.a === parts.b) return iso(parts.year, parts.a, parts.b);
  return { ok: false, problem: "ambiguous" };
}

export interface DateDetection {
  /** Order proven by the values (or "ymd" when every value is year-first or has a month name). */
  order: DateOrder | null;
  /** Numeric day/month values exist and none of them proves the order. */
  ambiguous: boolean;
  /** Some values prove day-first and others month-first. */
  conflict: boolean;
  twoDigitYear: boolean;
}

export function detectDateOrder(values: readonly string[]): DateDetection {
  let dayFirst = false;
  let monthFirst = false;
  let pairs = 0;
  let twoDigitYear = false;
  for (const value of values) {
    const parts = value.trim() === "" ? null : shape(value);
    if (!parts || parts.kind !== "pair") continue;
    twoDigitYear ||= parts.twoDigitYear;
    if (parts.a !== parts.b) pairs += 1; // 01/01 reads the same either way
    if (parts.a > 12 && parts.b <= 12) dayFirst = true;
    if (parts.b > 12 && parts.a <= 12) monthFirst = true;
  }
  if (dayFirst && monthFirst) return { order: null, ambiguous: false, conflict: true, twoDigitYear };
  if (dayFirst) return { order: "dmy", ambiguous: false, conflict: false, twoDigitYear };
  if (monthFirst) return { order: "mdy", ambiguous: false, conflict: false, twoDigitYear };
  return { order: pairs === 0 ? "ymd" : null, ambiguous: pairs > 0, conflict: false, twoDigitYear };
}
