// Receipt text → structured fields, with a confidence for every field. Shared with Rails
// (app/services/finance/receipt_parser.rb); both replay fixtures/receipts/parse-cases.json.
//
// Input is recognized text in reading order: OCR lines from an on-device engine (Apple Vision,
// ML Kit, Tesseract, or iOS Shortcuts' "Extract Text from Image"), or the text layer of a PDF.
// Nothing here recognizes images and nothing leaves the device.
//
// Rules:
// - A field that cannot be read is null with confidence 0. Nothing is invented: no total is taken
//   from a lone number, no year from thin air, no currency without evidence (the caller's default
//   currency is used only when the receipt shows a bare "$" or no symbol, and that is reported).
// - Confidence is the OCR confidence of the line the value came from, scaled down by how indirect
//   the evidence is (an unlabeled amount, an assumed date order, totals that do not add up).
// - Amounts are integer minor units at scale 2 (cents); receipts in zero-decimal currencies
//   (JPY, KRW) are read as whole units and stored as units × 100, like the ledger stores them.
//   Formatted values are decimal strings with two decimals ("48.60").

export type ReceiptPaymentMethod = "card" | "cash" | "mobile" | "other";
export type ReceiptDirection = "purchase" | "refund";
export type ReceiptIssue =
  | "merchant_missing" | "date_missing" | "total_missing" | "total_inferred" | "totals_inconsistent" | "multiple_totals"
  | "date_ambiguous" | "future_date" | "currency_assumed" | "low_confidence";

export interface ReceiptLine {
  text: string;
  /** 0..1 from the OCR engine; null when unknown (a PDF text layer, Shortcuts text). */
  confidence: number | null;
}

export interface ReceiptField<T> {
  value: T | null;
  confidence: number;
  /** Index of the input line the value came from. */
  line: number | null;
}

export interface ReceiptItem {
  description: string;
  quantity: string | null;
  unitPrice: string | null;
  amount: string | null;
  confidence: number;
  line: number;
}

export interface ReceiptExtraction {
  version: 1;
  merchant: ReceiptField<string>;
  date: ReceiptField<string>;
  time: ReceiptField<string>;
  currency: ReceiptField<string>;
  total: ReceiptField<string>;
  subtotal: ReceiptField<string>;
  tax: ReceiptField<string>;
  tip: ReceiptField<string>;
  discount: ReceiptField<string>;
  paymentMethod: ReceiptField<ReceiptPaymentMethod>;
  cardLast4: ReceiptField<string>;
  receiptNumber: ReceiptField<string>;
  direction: ReceiptDirection;
  lineItems: ReceiptItem[];
  issues: ReceiptIssue[];
}

export interface ReceiptParseOptions {
  /** The book's currency; used for a bare "$" or no symbol, and then reported (currency_assumed). */
  defaultCurrency?: string | null;
  /** "YYYY-MM-DD"; dates after this (plus one day) are reported as future_date. */
  today?: string | null;
  /** Day/month order for numeric dates whose order the text does not prove. */
  dateOrder?: "mdy" | "dmy" | null;
  /** Confidence to use for lines without one (default 0.9). */
  textConfidence?: number;
}

/** Fields below this confidence are not trusted without a person (auto-recording and exact matching need it). */
export const RECEIPT_CONFIDENT = 0.8;

const round2 = (value: number) => Math.round(value * 100) / 100;
const empty = <T>(): ReceiptField<T> => ({ value: null, confidence: 0, line: null });
const field = <T>(value: T, confidence: number, line: number | null): ReceiptField<T> => ({ value, confidence: round2(Math.max(0, Math.min(1, confidence))), line });

export function formatMinor(minor: number): string {
  const sign = minor < 0 ? "-" : "";
  const abs = Math.abs(minor);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}

export function parseMinor(value: string | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const match = String(value).trim().match(/^(-)?(\d+)(?:\.(\d{1,2}))?$/);
  if (!match) return null;
  return (match[1] ? -1 : 1) * (Number(match[2]) * 100 + Number((match[3] ?? "0").padEnd(2, "0")));
}

// ---------------------------------------------------------------- amounts

const SYMBOLS: Array<[RegExp, string | null]> = [
  [/US\$/i, "USD"], [/C\$|CA\$/i, "CAD"], [/A\$|AU\$/i, "AUD"], [/HK\$/i, "HKD"], [/NT\$/i, "TWD"], [/S\$/i, "SGD"], [/MX\$/i, "MXN"],
  [/€/, "EUR"], [/£/, "GBP"], [/₩|원/, "KRW"], [/₹/, "INR"], [/円/, "JPY"], [/元|人民币|RMB/i, "CNY"],
];
const CODES = /\b(USD|EUR|GBP|JPY|CNY|CAD|AUD|KRW|INR|MXN|CHF|HKD|TWD|SGD|NZD|SEK|NOK|DKK)\b/;

interface AmountToken { minor: number; index: number; negative: boolean }

// Decimal amounts ("48.60", "1,234.56", "1.234,56", "12,50") and whole-unit amounts with a yen/won
// sign ("¥1,200", "1,200円"). Lookarounds keep dates (16.11.2026), percentages and phone numbers out.
const DECIMAL_AMOUNT = /(?<![\d.,])(\()?(-\s?)?(?:[$€£¥₩₹]\s?)?(\d{1,3}(?:[.,]\d{3})+|\d+)([.,])(\d{2})(?![\d%])(?![.,]\d)(?!\s?%)\s?(-|\)|CR\b)?/gi;
const WHOLE_AMOUNT = /(?:[¥₩]\s?(\d{1,3}(?:,\d{3})+|\d+)(?![\d.,]))|(?:(?<![\d.,])(\d{1,3}(?:,\d{3})+|\d+)\s?(?:円|원|元)(?![\d]))/g;

function amountsIn(text: string): AmountToken[] {
  const tokens: AmountToken[] = [];
  for (const match of text.matchAll(DECIMAL_AMOUNT)) {
    const whole = match[3].replace(/[.,]/g, "");
    if (whole.length > 11) continue;
    const negative = Boolean(match[1] || match[2] || match[6]);
    tokens.push({ minor: Number(whole) * 100 + Number(match[5]), index: match.index ?? 0, negative });
  }
  if (tokens.length === 0) {
    for (const match of text.matchAll(WHOLE_AMOUNT)) {
      const whole = (match[1] ?? match[2]).replace(/,/g, "");
      if (whole.length > 11) continue;
      tokens.push({ minor: Number(whole) * 100, index: match.index ?? 0, negative: false });
    }
  }
  return tokens;
}

// ---------------------------------------------------------------- labels

const TOTAL_STRONG = /\b(grand\s*total|total\s*due|amount\s*due|balance\s*due|total\s*to\s*pay|total\s*paid|amount\s*paid|total\s*charged|total\s*amount|importe\s*total|total\s*a\s*pagar|montant\s*total|gesamtbetrag|zu\s*zahlen)\b|合计|合計|总计|總計|应付|應付|实付|實付|お会計|合計金額|총액|합계|결제\s*금액/i;
const TOTAL_PLAIN = /\b(total|amount|summe|gesamt|montant|importe)\b/i;
const NOT_TOTAL = /sub\s*-?\s*total|total\s*(tax|savings?|saved|discount|items?|qty|quantity|count|number|tips?)\b|tax\s*total|items?\s*total|小计|小計|before\s*tip|pre-?\s*tip/i;
const SUBTOTAL = /sub\s*-?\s*total|zwischensumme|sous-?\s*total|小计|小計|소계/i;
const TAX = /\b(sales\s*tax|tax|vat|gst|hst|pst|qst|iva|mwst|tva|ust)\b|消費税|税额|稅額|税金|부가세|세금/i;
const TIP = /\b(tip|tips|gratuity|propina|pourboire|trinkgeld)\b|小费|小費|チップ|팁|봉사료/i;
const DISCOUNT = /\b(discount|savings|you\s*saved|coupon|promo|promotion|markdown|descuento|rabatt|remise)\b|折扣|优惠|優惠|割引|할인/i;
const CHANGE = /\b(change|change\s*due)\b|找零|お釣り|おつり|거스름/i;
const CASH = /\b(cash|efectivo|bar|esp[eè]ces)\b|现金|現金|현금/i;
const CARD = /\b(visa|mastercard|master\s*card|amex|american\s*express|discover|debit|credit|card|chip|contactless|tarjeta|carte|karte|ec-karte)\b|刷卡|信用卡|银行卡|銀行卡|カード|카드/i;
const MOBILE = /\b(apple\s*pay|google\s*pay|samsung\s*pay|paypal|venmo|alipay|wechat\s*pay)\b|支付宝|支付寶|微信支付/i;
const LAST4 = /(?:\*{2,}|x{3,}|#{2,}|ending\s*(?:in)?\s*|acct\s*[:#]?\s*\**|account\s*[:#]?\s*\**)\s*(\d{4})\b/i;
const RECEIPT_NO = /\b(?:receipt|rcpt|invoice|inv|order|trans(?:action)?|trx|txn|ticket|chk|ref(?:erence)?)\s*(?:no\.?|number|num|#|id)?\s*[:#.]?\s*([A-Z0-9][A-Z0-9-]{3,})\b|(?:单号|單號|伝票番号|영수증\s*번호)\s*[:：]?\s*([A-Z0-9-]{4,})/i;
const REFUND = /\b(refund|refunded|return|returned|credit\s*memo|reembolso|devoluci[oó]n|remboursement|erstattung)\b|退款|退货|退貨|返品|返金|환불/i;
const REFUND_POLICY = /\b(policy|within|days|accepted|receipt\s*required|eligible|exchange)\b/i;

const SKIP_HEADER = /^(welcome|thank\s*you|thanks|please|come\s*again|have\s*a|visit\s*us|receipt|sales\s*receipt|customer\s*copy|merchant\s*copy|order|invoice|tel|phone|fax|www\.|http|store\s*#|store\s*no|cashier|server|register|terminal|table|guest)/i;
const ADDRESS = /^\d+\s+\S+.*\b(st|street|ave|avenue|rd|road|blvd|boulevard|dr|drive|ln|lane|way|hwy|highway|pkwy|parkway|suite|ste|plaza|sq|square|ct|court|pl|place)\b\.?/i;
const PHONE = /\(?\b\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}\b/;
const CITY_ZIP = /\b[A-Z]{2}\s+\d{5}(?:-\d{4})?\b/;
const EMAIL_URL = /@|\bwww\.|https?:|\.com\b/i;

// ---------------------------------------------------------------- dates

const MONTHS: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };
const MONTH_NAMES = "jan|feb|mar|apr|may|jun|jul|aug|sept|sep|oct|nov|dec";
const ISO_DATE = /\b(20\d{2})[-/.](\d{1,2})[-/.](\d{1,2})\b/;
const CJK_DATE = /(20\d{2})\s*[年/]\s*(\d{1,2})\s*[月/]\s*(\d{1,2})\s*日?/;
const DAY_MONTH_NAME = new RegExp(`\\b(\\d{1,2})[\\s-](${MONTH_NAMES})[a-z]*\\.?[,\\s-]+(\\d{4}|\\d{2})(?![:\\d])`, "i");
const MONTH_NAME_DAY = new RegExp(`\\b(${MONTH_NAMES})[a-z]*\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(\\d{4}|\\d{2})(?![:\\d])`, "i");
const NUMERIC_DATE = /(?<![\d.])(\d{1,2})([/.-])(\d{1,2})\2(\d{4}|\d{2})(?![\d])/;
const TIME = /\b([01]?\d|2[0-3])[:：]([0-5]\d)(?::[0-5]\d)?\s*([ap]\.?m\.?)?(?![\d])/i;
const DATE_LABEL = /\b(date|fecha|datum|日期|日付|날짜)\b/i;

function validDate(year: number, month: number, day: number): string | null {
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

const fullYear = (text: string) => (text.length === 2 ? 2000 + Number(text) : Number(text));

interface DateHit { value: string; certainty: number; ambiguous: boolean }

function dateIn(text: string, order: "mdy" | "dmy" | null): DateHit | null {
  let match = text.match(ISO_DATE) ?? text.match(CJK_DATE);
  if (match) {
    const value = validDate(Number(match[1]), Number(match[2]), Number(match[3]));
    if (value) return { value, certainty: 1, ambiguous: false };
  }
  match = text.match(DAY_MONTH_NAME);
  if (match) {
    const value = validDate(fullYear(match[3]), MONTHS[match[2].toLowerCase().slice(0, match[2].toLowerCase().startsWith("sept") ? 4 : 3)] ?? 0, Number(match[1]));
    if (value) return { value, certainty: 1, ambiguous: false };
  }
  match = text.match(MONTH_NAME_DAY);
  if (match) {
    const value = validDate(fullYear(match[3]), MONTHS[match[1].toLowerCase().slice(0, match[1].toLowerCase().startsWith("sept") ? 4 : 3)] ?? 0, Number(match[2]));
    if (value) return { value, certainty: 1, ambiguous: false };
  }
  match = text.match(NUMERIC_DATE);
  if (match) {
    const first = Number(match[1]);
    const second = Number(match[3]);
    const year = fullYear(match[4]);
    if (first > 12 && second <= 12) {
      const value = validDate(year, second, first);
      if (value) return { value, certainty: 1, ambiguous: false };
    } else if (second > 12 && first <= 12) {
      const value = validDate(year, first, second);
      if (value) return { value, certainty: 1, ambiguous: false };
    } else if (first === second) {
      const value = validDate(year, first, second);
      if (value) return { value, certainty: 1, ambiguous: false };
    } else {
      // Both readings are valid dates: the text does not say which. A given order is trusted;
      // otherwise month-first is read (US receipts) and the date is marked for review.
      const chosen = order ?? "mdy";
      const value = chosen === "mdy" ? validDate(year, first, second) : validDate(year, second, first);
      if (value) return { value, certainty: order ? 0.95 : 0.5, ambiguous: !order };
    }
  }
  return null;
}

function timeIn(text: string): string | null {
  const match = text.match(TIME);
  if (!match) return null;
  let hour = Number(match[1]);
  const meridiem = match[3]?.toLowerCase().replace(/\./g, "");
  if (meridiem === "pm" && hour < 12) hour += 12;
  if (meridiem === "am" && hour === 12) hour = 0;
  return `${String(hour).padStart(2, "0")}:${match[2]}`;
}

// ---------------------------------------------------------------- parse

interface Labeled { index: number; minor: number; confidence: number; negative: boolean }

export function parseReceiptText(input: ReadonlyArray<ReceiptLine> | string, options: ReceiptParseOptions = {}): ReceiptExtraction {
  const fallback = options.textConfidence ?? 0.9;
  const lines: ReceiptLine[] = (typeof input === "string" ? input.split(/\r?\n/).map((text) => ({ text, confidence: null })) : [...input])
    .map((line) => ({ text: line.text.normalize("NFKC").replace(/\s+/g, " ").trim(), confidence: line.confidence }));
  const confidenceOf = (index: number) => lines[index].confidence ?? fallback;
  const issues = new Set<ReceiptIssue>();

  // Currency: an explicit code or a distinctive symbol anywhere on the receipt.
  let currency: ReceiptField<string> = empty();
  const allText = lines.map((line) => line.text).join("\n");
  const code = allText.match(CODES);
  if (code) currency = field(code[1].toUpperCase(), 0.95, null);
  else {
    for (const [pattern, iso] of SYMBOLS) {
      if (iso && pattern.test(allText)) {
        currency = field(iso, 0.9, null);
        break;
      }
    }
    if (currency.value === null && /¥|￥/.test(allText)) {
      // ¥ is both yen and yuan: Chinese characters without kana mean yuan.
      const iso = /[぀-ヿ]/.test(allText) ? "JPY" : /[一-鿿]/.test(allText) ? "CNY" : "JPY";
      currency = field(iso, 0.7, null);
    }
    if (currency.value === null && options.defaultCurrency) {
      currency = field(options.defaultCurrency.toUpperCase(), /\$/.test(allText) ? 0.8 : 0.6, null);
      issues.add("currency_assumed");
    }
  }

  const totals: Labeled[] = [];
  const strongTotals: Labeled[] = [];
  let subtotal: ReceiptField<string> = empty();
  let taxMinor = 0;
  let taxLine: number | null = null;
  let taxConfidence = 1;
  let tip: ReceiptField<string> = empty();
  let discountMinor = 0;
  let discountLine: number | null = null;
  let discountConfidence = 1;
  let payment: ReceiptField<ReceiptPaymentMethod> = empty();
  let last4: ReceiptField<string> = empty();
  let receiptNumber: ReceiptField<string> = empty();
  let refundSignal = false;
  const tenderMinor: number[] = [];
  let firstSummaryLine = lines.length;
  const amountLines: Array<{ index: number; tokens: AmountToken[] }> = [];

  lines.forEach((line, index) => {
    const text = line.text;
    if (text === "") return;
    let tokens = amountsIn(text);
    // A label alone on its line ("TOTAL") with the amount on the next line.
    const labelOnly = tokens.length === 0 && index + 1 < lines.length && amountsIn(lines[index + 1].text).length > 0 && lines[index + 1].text.replace(/[^\p{L}]/gu, "").length === 0;
    if (labelOnly) tokens = amountsIn(lines[index + 1].text);
    const confidence = confidenceOf(index);
    const last = tokens[tokens.length - 1];
    if (tokens.length > 0) amountLines.push({ index, tokens });

    if (!last4.value) {
      const card = text.match(LAST4);
      if (card && (CARD.test(text) || MOBILE.test(text) || /\*{2,}|x{3,}/i.test(text))) last4 = field(card[1], confidence, index);
    }
    if (!receiptNumber.value) {
      const number = text.match(RECEIPT_NO);
      const id = number && (number[1] ?? number[2]);
      if (id && /\d/.test(id) && !LAST4.test(text)) receiptNumber = field(id.toUpperCase(), confidence * 0.95, index);
    }
    if (MOBILE.test(text)) payment = payment.value === "mobile" ? payment : field("mobile", confidence, index);
    else if (CARD.test(text) && (last || LAST4.test(text)) && payment.value === null) payment = field("card", confidence, index);
    else if (CASH.test(text) && last && !CHANGE.test(text) && payment.value === null) payment = field("cash", confidence, index);
    if (REFUND.test(text) && !REFUND_POLICY.test(text) && last) refundSignal = true;
    if (!last) return;

    if (SUBTOTAL.test(text)) {
      if (subtotal.value === null) subtotal = field(formatMinor(last.minor), confidence, index);
      firstSummaryLine = Math.min(firstSummaryLine, index);
    } else if (TIP.test(text) && !TOTAL_STRONG.test(text)) {
      tip = field(formatMinor(last.minor), confidence, index);
      firstSummaryLine = Math.min(firstSummaryLine, index);
    } else if (TAX.test(text) && !TOTAL_STRONG.test(text) && !/\b(incl|included|inkl)\b/i.test(text)) {
      taxMinor += last.minor;
      taxLine ??= index;
      taxConfidence = Math.min(taxConfidence, confidence);
      firstSummaryLine = Math.min(firstSummaryLine, index);
    } else if (DISCOUNT.test(text) && !TOTAL_STRONG.test(text)) {
      discountMinor += last.minor;
      discountLine ??= index;
      discountConfidence = Math.min(discountConfidence, confidence);
    } else if (!NOT_TOTAL.test(text) && (TOTAL_STRONG.test(text) || TOTAL_PLAIN.test(text))) {
      const entry = { index, minor: last.minor, confidence, negative: last.negative };
      totals.push(entry);
      if (TOTAL_STRONG.test(text)) strongTotals.push(entry);
      firstSummaryLine = Math.min(firstSummaryLine, index);
    } else if ((CARD.test(text) || CASH.test(text) || MOBILE.test(text)) && !CHANGE.test(text)) {
      tenderMinor.push(last.minor);
      firstSummaryLine = Math.min(firstSummaryLine, index);
    }
  });

  // Total: the strongest label wins; among equals the last one (a total after the tip line).
  // A "BALANCE DUE 0.00" printed after payment is not the total.
  const positive = (entries: Labeled[]) => (entries.some((entry) => entry.minor > 0) ? entries.filter((entry) => entry.minor > 0) : entries);
  const pool = positive(strongTotals).length > 0 && strongTotals.some((entry) => entry.minor > 0) ? positive(strongTotals) : positive(totals);
  let total: ReceiptField<string> = empty();
  let totalNegative = false;
  if (pool.length > 0) {
    const chosen = pool[pool.length - 1];
    const distinct = new Set(pool.map((entry) => entry.minor));
    let confidence = chosen.confidence * (strongTotals.length > 0 ? 1 : 0.95);
    if (distinct.size > 1) {
      const tipMinor = parseMinor(tip.value);
      // Several totals are expected around a tip line (total before tip, total after tip).
      const explainedByTip = tipMinor !== null && [...distinct].some((value) => value + tipMinor === chosen.minor);
      if (!explainedByTip) {
        issues.add("multiple_totals");
        confidence *= 0.7;
      }
    }
    total = field(formatMinor(chosen.minor), confidence, chosen.index);
    totalNegative = chosen.negative;
  } else if (amountLines.length > 0) {
    // No labeled total: the largest amount is a guess and is marked as one.
    let best = amountLines[0];
    let bestMinor = -1;
    for (const entry of amountLines) {
      for (const token of entry.tokens) {
        if (token.minor > bestMinor) {
          bestMinor = token.minor;
          best = entry;
        }
      }
    }
    total = field(formatMinor(bestMinor), confidenceOf(best.index) * 0.4, best.index);
    issues.add("total_inferred");
  } else {
    issues.add("total_missing");
  }

  const tax = taxLine === null ? empty<string>() : field(formatMinor(taxMinor), taxConfidence, taxLine);
  const discount = discountLine === null ? empty<string>() : field(formatMinor(discountMinor), discountConfidence, discountLine);

  // Cross-check: subtotal − discount + tax + tip = total proves the total; a mismatch lowers it.
  const totalMinor = parseMinor(total.value);
  const subtotalMinor = parseMinor(subtotal.value);
  if (totalMinor !== null && subtotalMinor !== null) {
    const tipMinor = parseMinor(tip.value) ?? 0;
    const candidates = [subtotalMinor + taxMinor + tipMinor - discountMinor, subtotalMinor + taxMinor + tipMinor, subtotalMinor + taxMinor - discountMinor, subtotalMinor + taxMinor];
    if (candidates.includes(totalMinor)) total = field(total.value!, Math.max(total.confidence, Math.min(0.98, total.confidence + 0.1)), total.line);
    else {
      issues.add("totals_inconsistent");
      total = field(total.value!, total.confidence * 0.6, total.line);
    }
  }
  if (totalMinor !== null && tenderMinor.includes(totalMinor) && !issues.has("totals_inconsistent")) {
    total = field(total.value!, Math.min(0.99, total.confidence + 0.05), total.line);
  }

  // Merchant: the first header line that is not an address, phone, date, greeting or number.
  let merchant: ReceiptField<string> = empty();
  const headerEnd = Math.min(lines.length, 8);
  for (let index = 0; index < headerEnd; index += 1) {
    const text = lines[index].text.replace(/^welcome\s+to\s+/i, "");
    const lettersOnly = text.replace(/[^\p{L}]/gu, "");
    if (lettersOnly.length < 2) continue;
    if (SKIP_HEADER.test(text) || ADDRESS.test(text) || PHONE.test(text) || CITY_ZIP.test(text) || EMAIL_URL.test(text)) continue;
    if (dateIn(text, null) || amountsIn(text).length > 0) continue;
    if (TOTAL_PLAIN.test(text) || TAX.test(text)) continue;
    const name = text.replace(/\s*#\s*\d+\s*$/, "").replace(/\s+store\s+\d+$/i, "").trim();
    merchant = field(name, confidenceOf(index) * 0.9, index);
    break;
  }
  if (merchant.value === null) issues.add("merchant_missing");

  // Date and time: a labeled line first, then the first line with a date.
  let date: ReceiptField<string> = empty();
  let time: ReceiptField<string> = empty();
  const order = options.dateOrder ?? null;
  const dateLines = lines.map((line, index) => ({ line, index })).sort((a, b) => Number(DATE_LABEL.test(b.line.text)) - Number(DATE_LABEL.test(a.line.text)) || a.index - b.index);
  for (const { line, index } of dateLines) {
    const hit = dateIn(line.text, order);
    if (!hit) continue;
    date = field(hit.value, confidenceOf(index) * hit.certainty, index);
    if (hit.ambiguous) issues.add("date_ambiguous");
    const sameLineTime = timeIn(line.text.replace(ISO_DATE, " ").replace(NUMERIC_DATE, " "));
    if (sameLineTime) time = field(sameLineTime, confidenceOf(index), index);
    break;
  }
  if (time.value === null) {
    for (let index = 0; index < lines.length; index += 1) {
      const found = timeIn(lines[index].text);
      if (found) {
        time = field(found, confidenceOf(index) * 0.9, index);
        break;
      }
    }
  }
  if (date.value === null) issues.add("date_missing");
  else if (options.today) {
    const limit = new Date(`${options.today}T00:00:00Z`).getTime() + 86_400_000;
    if (new Date(`${date.value}T00:00:00Z`).getTime() > limit) {
      issues.add("future_date");
      date = field(date.value, Math.min(date.confidence, 0.3), date.line);
    }
  }

  // Line items: lines above the summary with a description and an amount.
  const lineItems: ReceiptItem[] = [];
  for (const { index, tokens } of amountLines) {
    if (index >= firstSummaryLine || index === merchant.line) continue;
    const text = lines[index].text;
    if (TOTAL_PLAIN.test(text) || TAX.test(text) || TIP.test(text) || DISCOUNT.test(text) || CHANGE.test(text) || CARD.test(text) || CASH.test(text) || DATE_LABEL.test(text)) continue;
    if (dateIn(text, order) && tokens.length === 0) continue;
    const description = text.slice(0, tokens[0].index).replace(/\s+(\d+\s*(?:x|@|×))\s*$/i, "").replace(/^\d+\s*(?:x|@|×)\s*/i, "").trim();
    if (description.replace(/[^\p{L}]/gu, "").length < 2) continue;
    const quantityMatch = text.match(/(?:^|\s)(\d{1,3})\s*(?:x|@|×)\s*/i) ?? text.match(/\bqty\s*[:.]?\s*(\d{1,3})\b/i);
    const quantity = quantityMatch ? quantityMatch[1] : null;
    const amount = tokens[tokens.length - 1];
    const unit = tokens.length >= 2 ? tokens[tokens.length - 2].minor : quantity && Number(quantity) > 0 && amount.minor % Number(quantity) === 0 ? amount.minor / Number(quantity) : null;
    lineItems.push({
      description: description.replace(/\s+/g, " "),
      quantity,
      unitPrice: unit === null ? null : formatMinor(unit),
      amount: formatMinor(amount.negative ? -amount.minor : amount.minor),
      confidence: round2(confidenceOf(index) * 0.9),
      line: index,
    });
  }

  const direction: ReceiptDirection = totalNegative || (refundSignal && totals.some((entry) => entry.negative || REFUND.test(lines[entry.index].text))) || (refundSignal && pool.length === 0) ? "refund" : "purchase";

  const extraction: ReceiptExtraction = {
    version: 1, merchant, date, time, currency, total, subtotal, tax, tip, discount,
    paymentMethod: payment, cardLast4: last4, receiptNumber, direction, lineItems, issues: [],
  };
  if ([merchant, date, total].some((key) => key.value !== null && key.confidence < 0.6)) issues.add("low_confidence");
  extraction.issues = [...issues].sort();
  return extraction;
}

/** Whether the merchant, date and total are all present and trusted (the gate for automatic recording). */
export function receiptConfident(extraction: Pick<ReceiptExtraction, "merchant" | "date" | "total" | "issues">): boolean {
  const blocking: ReceiptIssue[] = ["multiple_totals", "totals_inconsistent", "date_ambiguous", "future_date", "total_inferred"];
  return [extraction.merchant, extraction.date, extraction.total].every((key) => key.value !== null && key.confidence >= RECEIPT_CONFIDENT)
    && !extraction.issues.some((issue) => blocking.includes(issue));
}
