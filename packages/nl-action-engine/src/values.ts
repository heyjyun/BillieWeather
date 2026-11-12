// Built-in value extractors: dates and date ranges, money, numbers, quoted strings.
// They run on the match string and report spans so the parser can mark them as used.

import { matchPhrase, type PhoneticEncoder } from "./fuzzy";
import type { DateRangeValue, MoneyValue } from "./protocol";
import { parseLooseNumber, tokenize, type NormalizedText, type Token } from "./text";

export interface Found<T> {
  start: number;
  end: number;
  value: T;
  /** The text that produced the value (match string). */
  phrase: string;
  corrected: boolean;
  /** Assumption made to resolve the value (e.g. "past year for a month name"). */
  assumption?: string;
}

// ---------- calendar helpers (pure date arithmetic, no time zones) ----------

type Ymd = { y: number; m: number; d: number };
const pad = (n: number) => String(n).padStart(2, "0");
export const ymdToIso = ({ y, m, d }: Ymd) => `${y}-${pad(m)}-${pad(d)}`;
export function isoToYmd(iso: string): Ymd {
  const [y, m, d] = iso.split("-").map(Number);
  return { y, m, d };
}
const fromUtc = (date: Date): Ymd => ({ y: date.getUTCFullYear(), m: date.getUTCMonth() + 1, d: date.getUTCDate() });
const toUtc = ({ y, m, d }: Ymd) => new Date(Date.UTC(y, m - 1, d));
const addDays = (date: Ymd, days: number) => fromUtc(new Date(toUtc(date).getTime() + days * 86_400_000));
const daysInMonth = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();
const monthStart = (y: number, m: number): Ymd => ({ y, m, d: 1 });
const monthEnd = (y: number, m: number): Ymd => ({ y, m, d: daysInMonth(y, m) });
function addMonths(date: Ymd, months: number): Ymd {
  const index = date.y * 12 + (date.m - 1) + months;
  const y = Math.floor(index / 12);
  const m = (index % 12) + 1;
  return { y, m, d: Math.min(date.d, daysInMonth(y, m)) };
}
const validYmd = ({ y, m, d }: Ymd) => y >= 1900 && y <= 2200 && m >= 1 && m <= 12 && d >= 1 && d <= daysInMonth(y, m);
const range = (start: Ymd | null, end: Ymd | null): DateRangeValue => ({ start: start && ymdToIso(start), end: end && ymdToIso(end) });

/** Local calendar date of `now` as YYYY-MM-DD (the host may pass its own `today` instead). */
export function localIsoDate(now: Date): string {
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

const RELATIVE: Array<{ phrases: string[]; resolve: (today: Ymd) => DateRangeValue }> = [
  { phrases: ["today", "今天", "今日"], resolve: (t) => range(t, t) },
  { phrases: ["yesterday", "昨天", "昨日"], resolve: (t) => { const y = addDays(t, -1); return range(y, y); } },
  { phrases: ["this week", "本周", "这周", "这个星期", "本星期", "这星期"], resolve: (t) => { const start = addDays(t, -((toUtc(t).getUTCDay() + 6) % 7)); return range(start, addDays(start, 6)); } },
  { phrases: ["last week", "previous week", "上周", "上个星期", "上星期", "上礼拜"], resolve: (t) => { const start = addDays(t, -((toUtc(t).getUTCDay() + 6) % 7) - 7); return range(start, addDays(start, 6)); } },
  { phrases: ["this month", "本月", "这个月", "这月", "当月"], resolve: (t) => range(monthStart(t.y, t.m), monthEnd(t.y, t.m)) },
  { phrases: ["last month", "previous month", "上个月", "上月"], resolve: (t) => { const p = addMonths(monthStart(t.y, t.m), -1); return range(p, monthEnd(p.y, p.m)); } },
  { phrases: ["this year", "year to date", "ytd", "今年", "本年"], resolve: (t) => range({ y: t.y, m: 1, d: 1 }, { y: t.y, m: 12, d: 31 }) },
  { phrases: ["last year", "previous year", "去年", "上一年"], resolve: (t) => range({ y: t.y - 1, m: 1, d: 1 }, { y: t.y - 1, m: 12, d: 31 }) },
];

const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
const MONTH_ABBR: Record<string, number> = Object.fromEntries(MONTHS.flatMap((name, i) => [[name, i + 1], [name.slice(0, 3), i + 1], ...(name === "september" ? [["sept", 9]] : [])]));

/** A past month named without a year: this year, or last year if it has not started yet. */
function pastMonth(today: Ymd, month: number): { y: number; assumed: boolean } {
  return month > today.m ? { y: today.y - 1, assumed: true } : { y: today.y, assumed: false };
}

interface DateHit extends Found<DateRangeValue> { day: boolean }

export function findDates(source: NormalizedText, tokens: readonly Token[], todayIso: string, phonetic: PhoneticEncoder): Array<Found<DateRangeValue>> {
  const text = source.text;
  const today = isoToYmd(todayIso);
  const hits: DateHit[] = [];
  const taken = new Array<boolean>(text.length).fill(false);
  const free = (start: number, end: number) => { for (let i = start; i < end; i++) if (taken[i]) return false; return true; };
  const add = (hit: DateHit) => {
    if (!free(hit.start, hit.end)) return;
    for (let i = hit.start; i < hit.end; i++) taken[i] = true;
    hits.push(hit);
  };
  const each = (pattern: RegExp, handle: (match: RegExpMatchArray) => Omit<DateHit, "start" | "end" | "phrase" | "corrected"> | null) => {
    for (const match of text.matchAll(pattern)) {
      const value = handle(match);
      if (value) add({ ...value, start: match.index!, end: match.index! + match[0].length, phrase: match[0], corrected: false });
    }
  };
  const day = (ymd: Ymd) => (validYmd(ymd) ? { value: range(ymd, ymd), day: true } : null);

  each(/(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*[日号]?/g, (m) => day({ y: +m[1], m: +m[2], d: +m[3] }));
  each(/\b(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})\b/g, (m) => day({ y: +m[1], m: +m[2], d: +m[3] }));
  each(/\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/g, (m) => day({ y: +m[3], m: +m[1], d: +m[2] }));
  each(/(?:last|past|previous)\s+(\d+|a|an|one|two|three|four|five|six|seven|eight|nine|ten|twelve|thirty)\s+(day|week|month|year)s?\b/g, (m) => relativeSpan(today, parseLooseNumber(m[1]), m[2]));
  each(/(?:最近|过去|近)\s*(\d+|[一二两三四五六七八九十]+)\s*(天|日|个星期|星期|周|个月|月|年)/g, (m) => relativeSpan(today, parseLooseNumber(m[1]), m[2]));
  each(/(\d{4})\s*年\s*(\d{1,2})\s*月份?/g, (m) => (+m[2] >= 1 && +m[2] <= 12 ? { value: range(monthStart(+m[1], +m[2]), monthEnd(+m[1], +m[2])), day: false } : null));
  each(/(\d{4})\s*年(?!\s*\d)/g, (m) => ({ value: range({ y: +m[1], m: 1, d: 1 }, { y: +m[1], m: 12, d: 31 }), day: false }));
  each(/(?<![\d个])(\d{1,2}|十[一二]?|[一二三四五六七八九])\s*月份?(?!\s*\d)/g, (m) => {
    const month = parseLooseNumber(m[1]);
    if (!month || month < 1 || month > 12) return null;
    const { y, assumed } = pastMonth(today, month);
    return { value: range(monthStart(y, month), monthEnd(y, month)), day: false, assumption: assumed ? "pastYearMonth" : undefined };
  });
  each(/\b(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sept|sep|oct|nov|dec)\b(?:\s+(\d{1,2})(?:st|nd|rd|th)?\b)?(?:,?\s+(\d{4})\b)?/g, (m) => {
    const month = MONTH_ABBR[m[1]];
    const before = text.slice(Math.max(0, m.index! - 6), m.index!);
    // "may" is usually a verb: only read it as a month with a day, a year, or "in/since/of".
    if (m[1] === "may" && !m[2] && !m[3] && !/\b(in|of|since|for)\s+$/.test(before)) return null;
    if (m[2]) {
      const year = m[3] ? +m[3] : pastMonth(today, month).y;
      return day({ y: year, m: month, d: +m[2] });
    }
    const { y, assumed } = m[3] ? { y: +m[3], assumed: false } : pastMonth(today, month);
    return { value: range(monthStart(y, month), monthEnd(y, month)), day: false, assumption: assumed ? "pastYearMonth" : undefined };
  });

  // Relative phrases, typo/homophone tolerant ("last mnth", "上个越").
  for (const entry of RELATIVE) {
    for (const phrase of entry.phrases) {
      const pattern = tokenize(phrase);
      const match = matchPhrase(pattern, tokens, { phonetic }, (i) => free(tokens[i].start, tokens[i].end));
      if (!match || match.matched.length !== pattern.length || match.last - match.first + 1 !== pattern.length || match.quality < 0.8) continue;
      // Single short English words must be exact ("today" yes, "toda" no).
      if (pattern.length === 1 && pattern[0].kind === "word" && match.corrections.length && pattern[0].text.length < 6) continue;
      const start = tokens[match.first].start;
      const end = tokens[match.last].end;
      add({ start, end, value: entry.resolve(today), phrase: text.slice(start, end), corrected: match.corrections.length > 0, day: false });
    }
  }

  hits.sort((a, b) => a.start - b.start);
  // Two single days joined by "to / until / through / and / 到 / 至 / -" form one range.
  const out: Array<Found<DateRangeValue>> = [];
  for (let i = 0; i < hits.length; i++) {
    const a = hits[i];
    const b = hits[i + 1];
    if (b && a.day && b.day && /^\s*(?:to|until|till|through|thru|and|-|~|到|至|和)\s*$/.test(text.slice(a.end, b.start))) {
      const [start, end] = [a.value.start!, b.value.start!].sort();
      out.push({ start: a.start, end: b.end, value: { start, end }, phrase: text.slice(a.start, b.end), corrected: a.corrected || b.corrected });
      i += 1;
      continue;
    }
    // "since <date>" → open-ended range.
    // "from <one day>" also starts a range; "from last week" means during last week.
    if (/(?:since|after)\s+$/.test(text.slice(Math.max(0, a.start - 7), a.start)) || (a.day && /from\s+$/.test(text.slice(Math.max(0, a.start - 5), a.start))) || /^\s*(?:以来|之后|起)/.test(text.slice(a.end, a.end + 3))) {
      out.push({ ...a, value: { start: a.value.start, end: null } });
      continue;
    }
    if (/(?:before|until)\s+$/.test(text.slice(Math.max(0, a.start - 7), a.start)) || /^\s*(?:之前|以前)/.test(text.slice(a.end, a.end + 3))) {
      out.push({ ...a, value: { start: null, end: a.value.end } });
      continue;
    }
    out.push(a);
  }
  return out;
}

function relativeSpan(today: Ymd, count: number | null, unit: string) {
  if (!count || count < 1 || count > 3650) return null;
  let start: Ymd;
  if (/^(day|天|日)$/.test(unit)) start = addDays(today, -(count - 1));
  else if (/^(week|周|星期|个星期)$/.test(unit)) start = addDays(today, -(count * 7 - 1));
  else if (/^(month|个月|月)$/.test(unit)) start = addDays(addMonths(today, -count), 1);
  else start = addDays(addMonths(today, -12 * count), 1);
  return { value: range(start, today), day: false };
}

// ---------- money ----------

const COMPARATORS: Array<[RegExp, MoneyValue["comparator"]]> = [
  [/^(?:over|above|more than|greater than|bigger than|超过|大于|高于|多于|以上)$/, "gt"],
  [/^(?:at least|no less than|minimum|不少于|至少|不低于)$/, "gte"],
  [/^(?:under|below|less than|smaller than|少于|低于|小于|以下|不到)$/, "lt"],
  [/^(?:at most|no more than|up to|maximum|不超过|最多|不高于)$/, "lte"],
];
const CURRENCY_WORDS: Record<string, string> = {
  "$": "USD", usd: "USD", dollar: "USD", dollars: "USD", bucks: "USD", "美元": "USD", "美金": "USD",
  "¥": "CNY", "￥": "CNY", cny: "CNY", rmb: "CNY", "元": "CNY", "块": "CNY", "块钱": "CNY", "人民币": "CNY",
  "€": "EUR", eur: "EUR", euro: "EUR", euros: "EUR", "欧元": "EUR", "£": "GBP", gbp: "GBP", pound: "GBP", pounds: "GBP", "英镑": "GBP",
};

const MONEY = /(?:(over|above|more than|greater than|bigger than|at least|no less than|under|below|less than|smaller than|at most|no more than|up to|超过|大于|高于|多于|不少于|至少|不低于|少于|低于|小于|不到|不超过|最多|不高于)\s*)?(?:([$¥￥€£]|usd|cny|rmb|eur|gbp)\s*)?(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?\s*(dollars?|bucks|usd|euros?|eur|pounds?|gbp|rmb|cny|块钱|美元|美金|人民币|欧元|英镑|元|块)?(?:\s*(以上|以下))?/g;

/**
 * Amounts with a currency sign, a currency word or a comparison ("over 50"): plain numbers alone
 * are not money. `defaultCurrency` fills an amount with no currency (null = unknown).
 */
export function findMoney(source: NormalizedText, defaultCurrency: string | null): Array<Found<MoneyValue>> {
  const found: Array<Found<MoneyValue>> = [];
  for (const match of source.text.matchAll(MONEY)) {
    const [, comparatorWord, symbol, whole, fraction, unit, suffix] = match;
    if (!comparatorWord && !symbol && !unit) continue;
    let comparator: MoneyValue["comparator"] = "eq";
    for (const [pattern, value] of COMPARATORS) if ((comparatorWord && pattern.test(comparatorWord)) || (suffix && pattern.test(suffix))) comparator = value;
    const amountMinor = Number(whole.replace(/,/g, "")) * 100 + (fraction ? Number(fraction.padEnd(2, "0")) : 0);
    const currency = CURRENCY_WORDS[symbol ?? ""] ?? CURRENCY_WORDS[unit ?? ""] ?? defaultCurrency;
    found.push({ start: match.index!, end: match.index! + match[0].length, value: { amountMinor, currency, comparator }, phrase: match[0], corrected: false });
  }
  return found;
}

export function findNumbers(source: NormalizedText): Array<Found<number>> {
  const found: Array<Found<number>> = [];
  for (const match of source.text.matchAll(/-?\d+(?:\.\d+)?|[零一二两三四五六七八九十百千]+/g)) {
    const value = match[0].startsWith("-") ? -Number(match[0].slice(1)) : parseLooseNumber(match[0]);
    if (value === null || Number.isNaN(value)) continue;
    found.push({ start: match.index!, end: match.index! + match[0].length, value, phrase: match[0], corrected: false });
  }
  return found;
}

/** Quoted strings, returned exactly as typed (quotes removed). */
export function findQuoted(source: NormalizedText): Array<Found<string>> {
  const found: Array<Found<string>> = [];
  // Normalization maps “” 「」 『』 《》 ‘’ to plain quotes.
  for (const match of source.text.matchAll(/"([^"]+)"|(?:^|[\s(:,])'([^']+)'(?=$|[\s),.!?])/g)) {
    const inner = match[1] ?? match[2];
    const offset = match[0].indexOf(inner);
    const start = match.index! + offset;
    const end = start + inner.length;
    const raw = source.original.slice(source.map[start], end >= source.text.length ? source.original.length : source.map[end]);
    found.push({ start: start - 1, end: end + 1, value: raw.trim(), phrase: inner, corrected: false });
  }
  return found;
}
