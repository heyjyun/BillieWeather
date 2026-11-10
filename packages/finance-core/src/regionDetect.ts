// Suggests which country / region a statement most likely comes from, from the statement itself.
//
// - Deterministic and rule-based: fixed lists and patterns, a weighted score per region. No
//   network, no model, no device/IP location, no account region. Same input, same answer.
// - Only evidence inside the file counts: bank names and identifiers, account-number formats
//   (with checksums where they exist), postal addresses, payment networks, currency and date style.
// - Currency and date style are weak on purpose: USD is used far outside the United States, so
//   they can support a detection but never make one confident on their own. The script a
//   statement is written in (for example Chinese) is not evidence at all.
// - The result is a suggestion. It never changes the region a person chose (see checkRegion).
// - Evidence records name the rule that matched (a bank from the list below, "IBAN DE", "USD"),
//   never text or numbers copied from the document, so they are safe to store and show.
import type { ImportDraft } from "./universal/pipeline";
import { normalizeRegion, STATEMENT_REGIONS, type StatementRegion } from "./regions";

export type RegionConfidence = "high" | "medium" | "low";

/** Kinds of evidence. Identifier kinds are the strong ones (see ANCHOR_SIGNALS). */
export type RegionSignal =
  | "bank" | "routing_number" | "iban" | "sort_code" | "bsb" | "ifsc" | "clabe" | "transit_number" | "account_format"
  | "postal_address" | "country_name" | "payment_network" | "currency" | "date_format";

export interface RegionEvidence {
  region: StatementRegion;
  signal: RegionSignal;
  /** A fixed label from this file's rules (bank or network name, IBAN country, currency code); never document text. */
  detail: string | null;
  weight: number;
}

export interface RegionDetection {
  /** Most likely region, or null when nothing points anywhere (or two regions tie). */
  detectedRegion: StatementRegion | null;
  /** Null exactly when detectedRegion is null. */
  confidence: RegionConfidence | null;
  /** Evidence for the detected region, strongest first. */
  evidence: RegionEvidence[];
  /** Evidence for any other region, strongest first. */
  conflictingEvidence: RegionEvidence[];
}

export interface RegionDetectionInput {
  /** Text of the statement (header lines, cells, transaction descriptions). Only the first part is read. */
  text: string;
  institution?: string | null;
  currency?: string | null;
  /** Date order the file uses, when known ("mdy", "dmy", "ymd"). */
  dateOrder?: string | null;
  /** Structured bank identifiers (OFX BANKID). */
  bankIds?: ReadonlyArray<string | null>;
}

export const NO_DETECTION: RegionDetection = Object.freeze({ detectedRegion: null, confidence: null, evidence: [], conflictingEvidence: [] }) as RegionDetection;

const MAX_TEXT = 200_000;
const WORD_CHAR = "[\\p{L}\\p{M}\\p{Nd}\\p{Pc}]";
const escape = (word: string) => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** Latin-script names: whole words, any case. */
const words = (...list: string[]) => new RegExp(`(?<!${WORD_CHAR})(?:${list.map(escape).join("|")})(?!${WORD_CHAR})`, "iu");
/** CJK names have no spaces around them, so they match anywhere. */
const anywhere = (...list: string[]) => new RegExp(`(?:${list.map(escape).join("|")})`, "iu");

type Rule = readonly [StatementRegion, string, RegExp];

// Banks that clearly belong to one region. Global brands (HSBC, Citi, Standard Chartered, plain
// "Santander", "BBVA", "ANZ", "Westpac", "DBS"…) only count in a form that names the region.
const BANKS: readonly Rule[] = [
  ["US", "Bank of America", words("bank of america")],
  ["US", "Wells Fargo", words("wells fargo")],
  ["US", "JPMorgan Chase", words("jpmorgan chase", "chase bank", "chase freedom", "chase sapphire")],
  ["US", "Capital One", words("capital one")],
  ["US", "U.S. Bank", words("u.s. bank", "us bank national association", "u.s. bancorp")],
  ["US", "PNC Bank", words("pnc bank")],
  ["US", "Truist", words("truist")],
  ["US", "Ally Bank", words("ally bank")],
  ["US", "Discover Bank", words("discover bank")],
  ["US", "Navy Federal Credit Union", words("navy federal")],
  ["US", "USAA", words("usaa federal savings bank", "usaa")],
  ["US", "Fifth Third Bank", words("fifth third")],
  ["US", "Huntington", words("huntington national bank")],
  ["US", "KeyBank", words("keybank")],
  ["US", "Charles Schwab Bank", words("charles schwab bank", "schwab bank")],
  ["US", "American Express National Bank", words("american express national bank")],
  ["CN", "中国工商银行", anywhere("中国工商银行")],
  ["CN", "中国建设银行", anywhere("中国建设银行")],
  ["CN", "中国农业银行", anywhere("中国农业银行")],
  ["CN", "中国银行", /中国银行(?![(（](?:香港|澳门)[)）])/u],
  ["CN", "交通银行", anywhere("交通银行")],
  ["CN", "招商银行", anywhere("招商银行")],
  ["CN", "中国邮政储蓄银行", anywhere("中国邮政储蓄银行", "邮储银行")],
  ["CN", "浦发银行", anywhere("浦发银行", "上海浦东发展银行")],
  ["CN", "中信银行", anywhere("中信银行")],
  ["CN", "中国民生银行", anywhere("民生银行")],
  ["CN", "兴业银行", anywhere("兴业银行")],
  ["CN", "平安银行", anywhere("平安银行")],
  ["CN", "中国光大银行", anywhere("光大银行")],
  ["HK", "Hang Seng Bank", words("hang seng bank")],
  ["HK", "恒生銀行", anywhere("恒生銀行")],
  ["HK", "Bank of China (Hong Kong)", words("bank of china (hong kong)", "bochk")],
  ["HK", "中國銀行(香港)", anywhere("中國銀行(香港)", "中國銀行（香港）", "中国银行(香港)", "中国银行（香港）")],
  ["HK", "The Hongkong and Shanghai Banking Corporation", words("hongkong and shanghai banking corporation")],
  ["HK", "香港上海滙豐銀行", anywhere("香港上海滙豐銀行", "香港上海匯豐銀行")],
  ["HK", "Bank of East Asia", words("bank of east asia")],
  ["HK", "東亞銀行", anywhere("東亞銀行")],
  ["HK", "Dah Sing Bank", words("dah sing bank")],
  ["HK", "大新銀行", anywhere("大新銀行")],
  ["HK", "ZA Bank", words("za bank")],
  ["HK", "Mox Bank", words("mox bank")],
  ["TW", "臺灣銀行", anywhere("臺灣銀行", "台灣銀行")],
  ["TW", "國泰世華銀行", anywhere("國泰世華")],
  ["TW", "中國信託", anywhere("中國信託", "中國信托")],
  ["TW", "CTBC Bank", words("ctbc bank")],
  ["TW", "玉山銀行", anywhere("玉山銀行")],
  ["TW", "E.SUN Bank", words("e.sun bank", "esun bank")],
  ["TW", "台新銀行", anywhere("台新銀行", "台新國際商業銀行")],
  ["TW", "第一銀行", anywhere("第一商業銀行", "第一銀行")],
  ["TW", "華南銀行", anywhere("華南商業銀行", "華南銀行")],
  ["TW", "彰化銀行", anywhere("彰化商業銀行", "彰化銀行")],
  ["TW", "台北富邦銀行", anywhere("台北富邦", "臺北富邦")],
  ["TW", "中華郵政", anywhere("中華郵政")],
  ["MO", "大西洋銀行", anywhere("大西洋銀行")],
  ["MO", "Banco Nacional Ultramarino", words("banco nacional ultramarino")],
  ["MO", "澳門國際銀行", anywhere("澳門國際銀行")],
  ["MO", "Luso International Bank", words("luso international bank")],
  ["MO", "大豐銀行", anywhere("大豐銀行")],
  ["MO", "Tai Fung Bank", words("tai fung bank")],
  ["CA", "Royal Bank of Canada", words("royal bank of canada", "rbc royal bank")],
  ["CA", "TD Canada Trust", words("td canada trust")],
  ["CA", "Scotiabank", words("scotiabank", "bank of nova scotia")],
  ["CA", "Bank of Montreal", words("bank of montreal", "bmo bank of montreal")],
  ["CA", "CIBC", words("cibc", "canadian imperial bank of commerce")],
  ["CA", "Desjardins", words("desjardins")],
  ["CA", "National Bank of Canada", words("national bank of canada", "banque nationale du canada")],
  ["CA", "Tangerine", words("tangerine bank")],
  ["CA", "EQ Bank", words("eq bank")],
  ["GB", "Barclays Bank UK", words("barclays bank uk")],
  ["GB", "Lloyds Bank", words("lloyds bank")],
  ["GB", "NatWest", words("natwest", "national westminster bank")],
  ["GB", "Halifax", words("halifax bank", "halifax plc")],
  ["GB", "Santander UK", words("santander uk")],
  ["GB", "Nationwide Building Society", words("nationwide building society")],
  ["GB", "Monzo", words("monzo")],
  ["GB", "Starling Bank", words("starling bank")],
  ["GB", "HSBC UK", words("hsbc uk")],
  ["GB", "Royal Bank of Scotland", words("royal bank of scotland")],
  ["GB", "TSB Bank", words("tsb bank")],
  ["GB", "Metro Bank", words("metro bank")],
  ["GB", "first direct", words("first direct")],
  ["IE", "AIB", words("allied irish banks", "aib")],
  ["IE", "Bank of Ireland", words("bank of ireland")],
  ["IE", "Permanent TSB", words("permanent tsb", "ptsb")],
  ["JP", "三菱UFJ銀行", anywhere("三菱UFJ銀行", "三菱ＵＦＪ銀行")],
  ["JP", "MUFG Bank", words("mufg bank")],
  ["JP", "みずほ銀行", anywhere("みずほ銀行")],
  ["JP", "Mizuho Bank", words("mizuho bank")],
  ["JP", "三井住友銀行", anywhere("三井住友銀行")],
  ["JP", "SMBC", words("sumitomo mitsui banking", "smbc")],
  ["JP", "ゆうちょ銀行", anywhere("ゆうちょ銀行")],
  ["JP", "Japan Post Bank", words("japan post bank")],
  ["JP", "楽天銀行", anywhere("楽天銀行")],
  ["JP", "Rakuten Bank", words("rakuten bank")],
  ["JP", "りそな銀行", anywhere("りそな銀行")],
  ["JP", "住信SBIネット銀行", anywhere("住信SBIネット銀行")],
  ["KR", "KB국민은행", anywhere("국민은행")],
  ["KR", "KB Kookmin Bank", words("kookmin bank")],
  ["KR", "신한은행", anywhere("신한은행")],
  ["KR", "Shinhan Bank", words("shinhan bank")],
  ["KR", "우리은행", anywhere("우리은행")],
  ["KR", "Woori Bank", words("woori bank")],
  ["KR", "하나은행", anywhere("하나은행")],
  ["KR", "카카오뱅크", anywhere("카카오뱅크")],
  ["KR", "KakaoBank", words("kakaobank", "kakao bank")],
  ["KR", "NH농협", anywhere("농협은행", "nh농협")],
  ["KR", "토스뱅크", anywhere("토스뱅크")],
  ["SG", "POSB", words("posb")],
  ["SG", "DBS Bank Singapore", words("development bank of singapore", "dbs bank ltd")],
  ["SG", "OCBC Bank Singapore", words("oversea-chinese banking corporation")],
  ["MY", "Maybank", words("maybank", "malayan banking")],
  ["MY", "CIMB Bank", words("cimb bank berhad", "cimb bank")],
  ["MY", "Public Bank Berhad", words("public bank berhad")],
  ["MY", "RHB Bank", words("rhb bank")],
  ["MY", "Hong Leong Bank", words("hong leong bank")],
  ["MY", "AmBank", words("ambank")],
  ["MY", "Bank Islam", words("bank islam malaysia", "bank islam")],
  ["AU", "Commonwealth Bank", words("commonwealth bank", "commbank")],
  ["AU", "National Australia Bank", words("national australia bank")],
  ["AU", "Westpac Banking Corporation", words("westpac banking corporation")],
  ["AU", "Bendigo Bank", words("bendigo bank", "bendigo and adelaide bank")],
  ["AU", "Macquarie Bank", words("macquarie bank")],
  ["AU", "Suncorp", words("suncorp bank")],
  ["NZ", "Kiwibank", words("kiwibank")],
  ["NZ", "ASB Bank", words("asb bank")],
  ["NZ", "Bank of New Zealand", words("bank of new zealand", "bnz")],
  ["NZ", "ANZ Bank New Zealand", words("anz bank new zealand")],
  ["NZ", "Westpac New Zealand", words("westpac new zealand")],
  ["MX", "BBVA México", words("bbva méxico", "bbva mexico", "bbva bancomer")],
  ["MX", "Banorte", words("banorte")],
  ["MX", "Banamex", words("banamex", "citibanamex")],
  ["MX", "Santander México", words("santander méxico", "santander mexico")],
  ["MX", "Banco Azteca", words("banco azteca")],
  ["IN", "HDFC Bank", words("hdfc bank")],
  ["IN", "ICICI Bank", words("icici bank")],
  ["IN", "State Bank of India", words("state bank of india")],
  ["IN", "Axis Bank", words("axis bank")],
  ["IN", "Kotak Mahindra Bank", words("kotak mahindra")],
  ["IN", "Punjab National Bank", words("punjab national bank")],
  ["IN", "Bank of Baroda", words("bank of baroda")],
  ["DE", "Sparkasse", words("sparkasse", "stadtsparkasse", "kreissparkasse")],
  ["DE", "Deutsche Bank", words("deutsche bank")],
  ["DE", "Commerzbank", words("commerzbank")],
  ["DE", "Volksbank", words("volksbank")],
  ["DE", "Postbank", words("postbank")],
  ["DE", "DKB", words("deutsche kreditbank", "dkb")],
  ["DE", "HypoVereinsbank", words("hypovereinsbank")],
  ["DE", "comdirect", words("comdirect")],
  ["FR", "BNP Paribas", words("bnp paribas")],
  ["FR", "Crédit Agricole", words("crédit agricole", "credit agricole")],
  ["FR", "Société Générale", words("société générale", "societe generale")],
  ["FR", "Crédit Mutuel", words("crédit mutuel", "credit mutuel")],
  ["FR", "La Banque Postale", words("la banque postale")],
  ["FR", "Caisse d'Epargne", words("caisse d'epargne", "caisse d'épargne")],
  ["FR", "LCL", words("lcl")],
  ["FR", "Boursorama", words("boursorama", "boursobank")],
  ["FR", "Banque Populaire", words("banque populaire")],
  ["ES", "CaixaBank", words("caixabank")],
  ["ES", "Bankinter", words("bankinter")],
  ["ES", "Banco Sabadell", words("banco sabadell", "sabadell")],
  ["ES", "Kutxabank", words("kutxabank")],
  ["ES", "Unicaja", words("unicaja")],
  ["ES", "Ibercaja", words("ibercaja")],
  ["ES", "ABANCA", words("abanca")],
];

// Payment networks that only exist (or almost only) in one region. Ambiguous ones (plain "FPS"
// = UK Faster Payments or Hong Kong FPS, SEPA, Visa/Mastercard, Alipay/WeChat Pay, EFTPOS) are left out.
const NETWORKS: ReadonlyArray<readonly [StatementRegion, string, RegExp, number]> = [
  ["US", "Zelle", words("zelle"), 3],
  ["US", "Venmo", words("venmo"), 3],
  ["US", "Cash App", words("cash app"), 2],
  ["CA", "Interac", words("interac", "e-transfer", "etransfer"), 3],
  ["GB", "Faster Payments", words("faster payment", "faster payments", "fpi", "fpo"), 2],
  ["GB", "Bacs", words("bacs"), 2],
  ["HK", "轉數快 FPS", anywhere("轉數快", "转数快"), 3],
  ["HK", "Octopus", anywhere("八達通", "octopus card"), 2],
  ["TW", "街口支付", anywhere("街口支付", "jkopay"), 2],
  ["TW", "悠遊卡", anywhere("悠遊卡", "easycard"), 2],
  ["MO", "MPay", anywhere("澳門通", "mpay"), 2],
  ["CN", "财付通", anywhere("财付通"), 2],
  ["CN", "网联", anywhere("网联清算"), 2],
  ["SG", "PayNow", words("paynow"), 3],
  ["MY", "DuitNow", words("duitnow"), 3],
  ["MY", "FPX", words("fpx"), 2],
  ["IN", "UPI", words("upi"), 3],
  ["IN", "NEFT / IMPS", words("neft", "imps"), 3],
  ["MX", "SPEI", words("spei"), 3],
  ["AU", "BPAY", words("bpay"), 3],
  ["AU", "Osko / PayID", words("osko", "payid"), 3],
  ["JP", "PayPay", words("paypay"), 2],
  ["JP", "全銀", anywhere("振込手数料", "ﾌﾘｺﾐ"), 2],
  ["KR", "카카오페이", anywhere("카카오페이"), 2],
  ["ES", "Bizum", words("bizum"), 3],
  ["DE", "Lastschrift / girocard", words("lastschrift", "girocard"), 2],
  ["FR", "Prélèvement", words("prélèvement", "prelevement", "prlv sepa"), 2],
];

// Formal country names as printed in bank addresses. Plain "Hong Kong", "China", "Canada"… are
// left out: merchants are named after them ("HONG KONG EXPRESS", "CANADA GOOSE").
const COUNTRY_NAMES: readonly Rule[] = [
  ["US", "United States of America", words("united states of america")],
  ["CN", "中华人民共和国", anywhere("中华人民共和国")],
  ["HK", "Hong Kong SAR", anywhere("hong kong sar", "香港特别行政区", "香港特別行政區")],
  ["MO", "Macao SAR", anywhere("macao sar", "macau sar", "澳門特別行政區", "澳门特别行政区")],
  ["TW", "中華民國", anywhere("中華民國")],
  ["GB", "United Kingdom", words("united kingdom")],
];

const CURRENCY_REGION: Record<string, StatementRegion> = {
  CNY: "CN", RMB: "CN", HKD: "HK", TWD: "TW", NTD: "TW", MOP: "MO", CAD: "CA", GBP: "GB", JPY: "JP", KRW: "KR", SGD: "SG", MYR: "MY", AUD: "AU", NZD: "NZ", MXN: "MX", INR: "IN",
};

/** Weight of a currency: weak always. USD is widespread outside the United States, so it is weaker still. EUR names no single region. */
const CURRENCY_WEIGHT = 1;
const USD_WEIGHT = 0.5;

const US_STATES = "AL|AK|AZ|AR|CA|CO|CT|DE|DC|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY";
const US_ADDRESS = new RegExp(`[A-Za-z][A-Za-z .'-]{1,40},\\s*(?:${US_STATES})\\s+\\d{5}(?:-\\d{4})?(?!\\d)`, "u");
const CA_ADDRESS = /(?<![A-Za-z])(?:AB|BC|MB|NB|NL|NS|NT|NU|ON|PE|QC|SK|YT)\s+[ABCEGHJ-NPRSTVXY]\d[ABCEGHJ-NPRSTV-Z]\s?\d[ABCEGHJ-NPRSTV-Z]\d(?![A-Za-z0-9])/u;
const UK_POSTCODE = /(?<![A-Za-z0-9])(?:[A-PR-UWYZ][A-HK-Y]?\d[A-Z\d]?)\s\d[ABD-HJLNP-UW-Z]{2}(?![A-Za-z0-9])/u;
const NZ_ACCOUNT = /(?<!\d)\d{2}-\d{4}-\d{7}-\d{2,3}(?![\d-])/u;

const ROUTING_LABEL = /(?<![A-Za-z])(?:routing|aba|rtn)\s*(?:transit\s*)?(?:number|no\.?|#)?\s*[:#]?\s*(\d{9})(?!\d)/giu;
const SORT_CODE = /sort\s*code\s*[:#]?\s*(\d{2})[- ]?(\d{2})[- ]?(\d{2})(?!\d)/giu;
const BSB = /(?<![A-Za-z])BSB\s*(?:number|no\.?)?\s*[:#]?\s*(\d{3})[- ]?(\d{3})(?!\d)/giu;
const IFSC = /(?<![A-Za-z])IFSC(?:\s*code)?\s*[:#-]?\s*([A-Z]{4}0[A-Z0-9]{6})(?![A-Za-z0-9])/giu;
const CLABE = /(?<![A-Za-z])CLABE(?:\s*interbancaria)?\s*[:#]?\s*(\d{18})(?!\d)/giu;
const TRANSIT = /(?:transit|branch\s*transit)\s*(?:number|no\.?|#)\s*[:#]?\s*\d{5}(?!\d)|institution\s*(?:number|no\.?)\s*[:#]?\s*\d{3}\s*transit/iu;
const IBAN_CANDIDATE = /(?<![A-Z0-9])([A-Z]{2})(\d{2})((?:\s?[A-Z0-9]){10,30})(?![A-Z0-9])/gu;
/** IBAN lengths of the supported regions that use IBANs. */
const IBAN_LENGTH: Partial<Record<StatementRegion, number>> = { GB: 22, IE: 22, DE: 22, FR: 27, ES: 24 };

const W = { bank: 5, iban: 6, routing: 6, sortCode: 5, bsb: 5, ifsc: 6, clabe: 6, transit: 4, nzAccount: 4, address: 3, ukPostcode: 2, country: 2, dateFormat: 0.5 };

/** Identifier evidence: what can make a detection High. Payment networks, currency and date style cannot alone. */
const ANCHOR_SIGNALS: ReadonlySet<RegionSignal> = new Set(["bank", "routing_number", "iban", "sort_code", "bsb", "ifsc", "clabe", "transit_number", "account_format", "postal_address"]);
/** The most each signal kind can add for one region, so many repeated weak hints don't add up to certainty. */
const SIGNAL_CAP: Partial<Record<RegionSignal, number>> = { payment_network: 5, country_name: 2, currency: CURRENCY_WEIGHT, date_format: W.dateFormat, postal_address: 3 };

/** ABA routing-number checksum (3-7-1 weights). */
export function validAbaRouting(digits: string): boolean {
  if (!/^\d{9}$/.test(digits) || /^0{9}$/.test(digits)) return false;
  const d = [...digits].map(Number);
  return (3 * (d[0] + d[3] + d[6]) + 7 * (d[1] + d[4] + d[7]) + (d[2] + d[5] + d[8])) % 10 === 0;
}

/** ISO 13616 mod-97 check of an IBAN without spaces. */
export function validIban(iban: string): boolean {
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{10,30}$/.test(iban)) return false;
  const rearranged = iban.slice(4) + iban.slice(0, 4);
  let remainder = 0;
  for (const char of rearranged) {
    const value = /\d/.test(char) ? char : String(char.charCodeAt(0) - 55);
    for (const digit of value) remainder = (remainder * 10 + Number(digit)) % 97;
  }
  return remainder === 1;
}

/** Mexican CLABE check digit (weights 3, 7, 1). */
export function validClabe(digits: string): boolean {
  if (!/^\d{18}$/.test(digits)) return false;
  const weights = [3, 7, 1];
  const sum = [...digits.slice(0, 17)].reduce((total, digit, index) => total + ((Number(digit) * weights[index % 3]) % 10), 0);
  return (10 - (sum % 10)) % 10 === Number(digits[17]);
}

/** Scores the evidence in one statement. Pure and deterministic. */
export function detectRegion(input: RegionDetectionInput): RegionDetection {
  const raw = [input.institution ?? "", input.text ?? ""].join("\n").slice(0, MAX_TEXT);
  const text = raw.normalize("NFKC");
  const found = new Map<string, RegionEvidence>();
  const add = (region: StatementRegion, signal: RegionSignal, detail: string | null, weight: number) => {
    const key = `${region}|${signal}|${detail ?? ""}`;
    const existing = found.get(key);
    if (!existing || existing.weight < weight) found.set(key, { region, signal, detail, weight });
  };

  for (const [region, name, pattern] of BANKS) if (pattern.test(text)) add(region, "bank", name, W.bank);
  for (const [region, name, pattern, weight] of NETWORKS) if (pattern.test(text)) add(region, "payment_network", name, weight);
  for (const [region, name, pattern] of COUNTRY_NAMES) if (pattern.test(text)) add(region, "country_name", name, W.country);

  for (const match of text.matchAll(ROUTING_LABEL)) if (validAbaRouting(match[1])) add("US", "routing_number", null, W.routing);
  for (const id of input.bankIds ?? []) if (id && validAbaRouting(id.trim())) add("US", "routing_number", null, W.routing);
  for (const match of text.matchAll(SORT_CODE)) add(match[1].startsWith("9") ? "IE" : "GB", "sort_code", null, W.sortCode);
  for (const _ of text.matchAll(BSB)) add("AU", "bsb", null, W.bsb);
  for (const _ of text.toUpperCase().matchAll(IFSC)) add("IN", "ifsc", null, W.ifsc);
  for (const match of text.matchAll(CLABE)) if (validClabe(match[1])) add("MX", "clabe", null, W.clabe);
  if (TRANSIT.test(text)) add("CA", "transit_number", null, W.transit);
  if (NZ_ACCOUNT.test(text)) add("NZ", "account_format", null, W.nzAccount);
  for (const match of text.toUpperCase().matchAll(IBAN_CANDIDATE)) {
    // The candidate may run into the next word ("… 00 BALANCE"), so only the country's IBAN length is checked.
    const region = normalizeRegion(match[1]);
    const length = region ? IBAN_LENGTH[region] : undefined;
    const iban = (match[1] + match[2] + match[3]).replace(/\s/g, "").slice(0, length);
    if (region && length && iban.length === length && validIban(iban)) add(region, "iban", region, W.iban);
  }

  if (US_ADDRESS.test(text)) add("US", "postal_address", null, W.address);
  if (CA_ADDRESS.test(text)) add("CA", "postal_address", null, W.address);
  if (UK_POSTCODE.test(text)) add("GB", "postal_address", null, W.ukPostcode);

  const currency = input.currency?.trim().toUpperCase() ?? null;
  if (currency === "USD") add("US", "currency", "USD", USD_WEIGHT);
  else if (currency && CURRENCY_REGION[currency]) add(CURRENCY_REGION[currency], "currency", currency, CURRENCY_WEIGHT);
  if (input.dateOrder === "mdy") add("US", "date_format", "MM/DD/YYYY", W.dateFormat);

  return score([...found.values()]);
}

function score(all: RegionEvidence[]): RegionDetection {
  if (all.length === 0) return NO_DETECTION;
  const totals = new Map<StatementRegion, number>();
  const anchors = new Map<StatementRegion, number>();
  for (const region of STATEMENT_REGIONS) {
    const mine = all.filter((item) => item.region === region);
    if (mine.length === 0) continue;
    const bySignal = new Map<RegionSignal, number>();
    for (const item of mine) bySignal.set(item.signal, (bySignal.get(item.signal) ?? 0) + item.weight);
    let total = 0;
    let anchor = 0;
    for (const [signal, sum] of bySignal) {
      const capped = Math.min(sum, SIGNAL_CAP[signal] ?? Infinity);
      total += capped;
      if (ANCHOR_SIGNALS.has(signal)) anchor += capped;
    }
    totals.set(region, total);
    anchors.set(region, anchor);
  }
  // Highest score first; ties keep the fixed STATEMENT_REGIONS order so the result is deterministic.
  const ranked = [...totals.entries()].sort((a, b) => b[1] - a[1]);
  const [top, topScore] = ranked[0];
  const second = ranked[1]?.[1] ?? 0;
  const strongestFirst = (a: RegionEvidence, b: RegionEvidence) => b.weight - a.weight || a.signal.localeCompare(b.signal) || (a.detail ?? "").localeCompare(b.detail ?? "");
  if (topScore === second) {
    // Two regions tie: no detection, everything is conflicting evidence.
    return { detectedRegion: null, confidence: null, evidence: [], conflictingEvidence: [...all].sort(strongestFirst) };
  }
  const anchor = anchors.get(top) ?? 0;
  let confidence: RegionConfidence = "low";
  if (anchor >= 3 && topScore >= 5 && second * 2 < topScore && topScore - second >= 4) confidence = "high";
  else if (topScore >= 3 && second * 2 <= topScore) confidence = "medium";
  return {
    detectedRegion: top,
    confidence,
    evidence: all.filter((item) => item.region === top).sort(strongestFirst),
    conflictingEvidence: all.filter((item) => item.region !== top).sort(strongestFirst),
  };
}

/** Evidence inputs for a universal-import draft (CSV, TSV, Excel, OFX, OCR). */
export function regionInputFromDraft(draft: ImportDraft): RegionDetectionInput {
  const currency = draft.effective.currency ?? draft.detected.currency ?? null;
  if (draft.source.kind === "ofx") {
    const doc = draft.source.document;
    const parts: string[] = [doc.institution.org ?? ""];
    for (const statement of doc.statements) {
      for (const tx of statement.transactions.slice(0, 2000)) parts.push([tx.name, tx.memo, tx.payee].filter(Boolean).join(" "));
    }
    return { text: parts.join("\n"), institution: doc.institution.org, currency: doc.statements[0]?.currency ?? currency, dateOrder: null, bankIds: doc.statements.map((s) => s.bankId) };
  }
  const table = draft.source.tables[draft.source.sheetIndex];
  const lines: string[] = [];
  let length = 0;
  for (const row of table?.rows ?? []) {
    const line = row.map((cell) => cell.text).join(" ");
    lines.push(line);
    length += line.length + 1;
    if (length > MAX_TEXT) break;
  }
  return { text: lines.join("\n"), institution: draft.preamble.institution, currency, dateOrder: draft.effective.dateOrder };
}

/**
 * What to show for a statement, given the region a person selected (null = Not specified) and
 * the detection. Never changes the selection itself.
 * - suggest:  nothing selected and High confidence: offer the detected region (Scenario A).
 * - match:    the selection agrees with the detection (Scenario B).
 * - conflict: the selection disagrees with High-confidence evidence: a non-blocking warning (Scenario C).
 * - none:     too little evidence, or the person already chose to keep a conflicting selection (Scenario D).
 */
export type RegionCheck =
  | { kind: "suggest"; detected: StatementRegion }
  | { kind: "match"; detected: StatementRegion }
  | { kind: "conflict"; selected: StatementRegion; detected: StatementRegion }
  | { kind: "none" };

export function checkRegion(selected: string | null | undefined, detection: RegionDetection | null | undefined, options: { keptSelection?: boolean } = {}): RegionCheck {
  const chosen = normalizeRegion(selected);
  const detected = detection?.detectedRegion ?? null;
  if (!detected) return { kind: "none" };
  if (chosen === detected) return { kind: "match", detected };
  if (detection?.confidence !== "high") return { kind: "none" };
  if (!chosen) return { kind: "suggest", detected };
  if (options.keptSelection) return { kind: "none" };
  return { kind: "conflict", selected: chosen, detected };
}

/**
 * How a statement's region was decided, in priority order:
 * - "user": a person selected it (or kept it after a conflict warning: "user_confirmed");
 * - "suggestion": a person accepted the High-confidence suggestion;
 * - null: Not specified. Detection alone never sets a region.
 */
export type RegionSource = "user" | "user_confirmed" | "suggestion";

export function normalizeRegionSource(value: unknown): RegionSource | null {
  return value === "user" || value === "user_confirmed" || value === "suggestion" ? value : null;
}

export function normalizeConfidence(value: unknown): RegionConfidence | null {
  return value === "high" || value === "medium" || value === "low" ? value : null;
}

/** Stored form of the evidence (labels only; see the header comment). */
export function serializeDetection(detection: RegionDetection): string {
  return JSON.stringify({ evidence: detection.evidence, conflicting: detection.conflictingEvidence });
}

/** Reads a stored detection back; anything damaged or unknown reads as no detection. */
export function parseDetection(detectedRegion: unknown, confidence: unknown, evidenceJson: unknown): RegionDetection {
  const region = normalizeRegion(detectedRegion);
  const level = normalizeConfidence(confidence);
  let evidence: RegionEvidence[] = [];
  let conflicting: RegionEvidence[] = [];
  if (typeof evidenceJson === "string" && evidenceJson) {
    try {
      const parsed = JSON.parse(evidenceJson) as { evidence?: unknown; conflicting?: unknown };
      const clean = (list: unknown) => (Array.isArray(list) ? list : []).flatMap((item): RegionEvidence[] => {
        const r = normalizeRegion((item as RegionEvidence)?.region);
        const signal = (item as RegionEvidence)?.signal;
        const weight = Number((item as RegionEvidence)?.weight);
        if (!r || typeof signal !== "string" || !Number.isFinite(weight)) return [];
        const detail = (item as RegionEvidence).detail;
        return [{ region: r, signal: signal as RegionSignal, detail: typeof detail === "string" ? detail.slice(0, 80) : null, weight }];
      });
      evidence = clean(parsed.evidence);
      conflicting = clean(parsed.conflicting);
    } catch {
      // ignored: treated as no evidence
    }
  }
  if (!region || !level) return { ...NO_DETECTION, conflictingEvidence: conflicting };
  return { detectedRegion: region, confidence: level, evidence, conflictingEvidence: conflicting };
}
