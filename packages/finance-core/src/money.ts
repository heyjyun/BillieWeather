// Money as integer minor units. 12.34 is 1234. Parsing never goes through floats.

export const MONEY_LIMIT_CENTS = 10 ** 15; // Rails: |amount| < 10**13 units

/** "-12.5" -> -1250. Accepts [+-]digits[.d{1,2}] only (callers strip symbols/commas). */
export function decimalToCents(value: string): number {
  const match = /^([+-]?)(\d+)(?:\.(\d{1,2}))?$/.exec(value);
  if (!match) throw new Error(`Not a decimal amount: ${value}`);
  const [, sign, whole, fraction = ""] = match;
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  return sign === "-" && cents !== 0 ? -cents : cents;
}

/** Ruby BigDecimal#to_s("F"): -1250 -> "-12.5", 10000 -> "100.0", 5 -> "0.05". */
export function centsToDecimalString(cents: number): string {
  const negative = cents < 0;
  const abs = Math.abs(cents);
  const whole = Math.floor(abs / 100);
  const fraction = String(abs % 100).padStart(2, "0").replace(/0$/, "") || "0";
  return `${negative ? "-" : ""}${whole}.${fraction}`;
}

/** Plain number for spreadsheets: 1234 -> 12.34. Exact for |cents| < 2^53. */
export function centsToNumber(cents: number): number {
  return cents / 100;
}

const SYMBOLS: Record<string, string> = { USD: "$", CAD: "CA$", AUD: "A$", NZD: "NZ$", SGD: "S$", HKD: "HK$", EUR: "€", GBP: "£", CNY: "¥", JPY: "¥" };

/** Display only. */
export function formatMoney(cents: number, currency: string): string {
  const symbol = SYMBOLS[currency] ?? `${currency} `;
  const abs = Math.abs(cents);
  const whole = Math.floor(abs / 100).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${cents < 0 ? "-" : ""}${symbol}${whole}.${String(abs % 100).padStart(2, "0")}`;
}
