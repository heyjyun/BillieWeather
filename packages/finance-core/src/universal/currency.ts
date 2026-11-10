// ISO 4217 minor units and exact decimal <-> minor-unit conversion. No floating point.
//
// Local storage keeps the historical fixed scale of 2 (`amount_cents`, also for JPY: ¥1000
// is stored as 100000). `toStorageCents` converts canonical minor units into that scale and
// refuses anything it cannot represent exactly (for example 3-decimal currencies like KWD).

/** Currencies whose minor unit is not 2 decimals. Everything else listed in KNOWN_CURRENCIES uses 2. */
const EXPONENTS: Record<string, number> = {
  BIF: 0, CLP: 0, DJF: 0, GNF: 0, ISK: 0, JPY: 0, KMF: 0, KRW: 0, PYG: 0, RWF: 0, UGX: 0, UYI: 0, VND: 0, VUV: 0, XAF: 0, XOF: 0, XPF: 0,
  BHD: 3, IQD: 3, JOD: 3, KWD: 3, LYD: 3, OMR: 3, TND: 3,
  CLF: 4, UYW: 4,
};

export const KNOWN_CURRENCIES = new Set([
  ...Object.keys(EXPONENTS),
  "AED", "ARS", "AUD", "BDT", "BGN", "BRL", "CAD", "CHF", "CNY", "COP", "CZK", "DKK", "EGP", "EUR", "GBP", "HKD", "HUF", "IDR", "ILS", "INR",
  "KZT", "LKR", "MAD", "MOP", "MXN", "MYR", "NGN", "NOK", "NZD", "PEN", "PHP", "PKR", "PLN", "QAR", "RON", "RSD", "RUB", "SAR", "SEK", "SGD",
  "THB", "TRY", "TWD", "UAH", "USD", "ZAR",
]);

export function currencyExponent(code: string): number {
  return EXPONENTS[code] ?? 2;
}

export const MAX_ABS_MINOR = 10 ** 15; // same limit as MONEY_LIMIT_CENTS; well inside Number.MAX_SAFE_INTEGER

export type DecimalProblem = "unreadable" | "precision" | "too_large";

/**
 * "-1234.5" with exponent 2 -> -123450. Accepts [+-]digits[.digits]. Extra fraction digits
 * are only accepted when they are zeros ("12.340" for USD); otherwise "precision".
 */
export function decimalToMinor(text: string, exponent: number): { ok: true; minor: number } | { ok: false; problem: DecimalProblem } {
  const match = /^([+-]?)(\d+)(?:\.(\d+))?$/.exec(text);
  if (!match) return { ok: false, problem: "unreadable" };
  const [, sign, wholeRaw, fractionRaw = ""] = match;
  const significant = fractionRaw.replace(/0+$/, "");
  if (significant.length > exponent) return { ok: false, problem: "precision" };
  const whole = wholeRaw.replace(/^0+(?=\d)/, "");
  if (whole.length > 16) return { ok: false, problem: "too_large" };
  const digits = whole + fractionRaw.slice(0, exponent).padEnd(exponent, "0");
  const value = Number(digits); // an integer string, so this is exact while below 2^53
  if (!Number.isSafeInteger(value) || value >= MAX_ABS_MINOR) return { ok: false, problem: "too_large" };
  return { ok: true, minor: sign === "-" && value !== 0 ? -value : value };
}

/**
 * Spreadsheet numbers are binary doubles written as their shortest decimal text, so a value typed
 * as 0.3 can appear as "0.30000000000000004". Such text is rounded to the currency precision only
 * when the excess digits are clearly representation noise (|error| < 1e-6 of a minor unit);
 * otherwise the value genuinely has too much precision and is refused.
 */
export function spreadsheetNumberToMinor(text: string, exponent: number): { ok: true; minor: number; rounded: boolean } | { ok: false; problem: DecimalProblem } {
  const exact = decimalToMinor(text, exponent);
  if (exact.ok) return { ...exact, rounded: false };
  if (exact.problem !== "precision") return exact;
  const match = /^([+-]?)(\d+)\.(\d+)$/.exec(text);
  if (!match) return { ok: false, problem: "unreadable" };
  const [, sign, whole, fraction] = match;
  const kept = fraction.slice(0, exponent);
  const rest = fraction.slice(exponent);
  // rest is the fraction of one minor unit; noise means it is ~0 (000000x) or ~1 (999999x).
  const nearZero = /^0{6,}/.test(rest);
  const nearOne = /^9{6,}/.test(rest);
  if (!nearZero && !nearOne) return { ok: false, problem: "precision" };
  const base = decimalToMinor(`${whole}${exponent > 0 ? `.${kept}` : ""}`, exponent);
  if (!base.ok) return base;
  const magnitude = base.minor + (nearOne ? 1 : 0);
  if (magnitude >= MAX_ABS_MINOR) return { ok: false, problem: "too_large" };
  return { ok: true, minor: sign === "-" && magnitude !== 0 ? -magnitude : magnitude, rounded: true };
}

/** Canonical minor units -> the fixed scale-2 `amount_cents` used by local storage, or null when not exact. */
export function toStorageCents(minor: number, exponent: number): number | null {
  if (exponent === 2) return minor;
  if (exponent < 2) {
    const value = minor * 10 ** (2 - exponent);
    return Number.isSafeInteger(value) ? value : null;
  }
  const divisor = 10 ** (exponent - 2);
  return minor % divisor === 0 ? minor / divisor : null;
}

/** Display/audit text for a minor-unit amount: (-123450, 2) -> "-1234.50". */
export function minorToDecimalString(minor: number, exponent: number): string {
  const negative = minor < 0;
  const digits = String(Math.abs(minor)).padStart(exponent + 1, "0");
  const whole = exponent === 0 ? digits : digits.slice(0, -exponent);
  const fraction = exponent === 0 ? "" : `.${digits.slice(-exponent)}`;
  return `${negative ? "-" : ""}${whole}${fraction}`;
}
