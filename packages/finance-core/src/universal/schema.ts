// BillieWeather Financial Data Schema, version 1.
//
// Every supported input (CSV, TSV, Excel, OFX/QFX, text PDF, OCR) is turned into these
// records before anything is stored. Storage adapters (SQLite on devices, PostgreSQL on the
// website) map them onto their own tables; financial logic never depends on the source format.
//
// Rules that hold for every record:
// - Amounts are integers in the currency's ISO 4217 minor unit (`amountMinor`, `currencyExponent`).
//   No binary floating point is ever used to hold or compute money.
// - Negative amounts are money leaving the account, positive amounts are money arriving.
//   `direction` states the same thing explicitly so that sign mistakes can be cross-checked.
// - Original values are kept (`originalDescription`, `raw`) and are never replaced by a
//   normalized, translated or currency-converted value.
// - A record that is not `valid` is never committed unless a person explicitly decided it.
import type { Category, IsoDate } from "@billie/shared-types";

export const SCHEMA_VERSION = 1 as const;

export type SourceFormat = "csv" | "tsv" | "xlsx" | "ofx" | "pdf_text" | "pdf_scanned" | "image";

export type Direction = "debit" | "credit" | "zero";

export type AccountKind = "checking" | "savings" | "credit_card" | "loan" | "unknown";

/** Who decided a transaction's category. A person's choice always wins over automation. */
export type CategorySource = "user" | "rule" | "file" | "auto" | "region";
// "region": only the statement's optional region matched (regions.ts); reclassifying may change it.

/** What a description or bank code suggests the transaction is. Hints only: they never change amounts. */
export type KindHint = "transfer" | "card_payment" | "refund" | "reversal" | "chargeback" | "fee" | "interest" | "fx_adjustment" | "cash";

export type ValidationStatus = "valid" | "needs_review" | "rejected";

/** `error`: cannot be committed as is. `review`: a person must decide. `info`: shown, never blocks. */
export type IssueSeverity = "error" | "review" | "info";

export interface Issue {
  code: IssueCode;
  severity: IssueSeverity;
  field?: CanonicalField;
  vars?: Record<string, string | number>;
}

export type IssueCode =
  // dates
  | "date_missing" | "date_unreadable" | "date_invalid" | "date_order_ambiguous" | "date_out_of_range" | "date_future"
  // amounts
  | "amount_missing" | "amount_unreadable" | "amount_precision" | "amount_too_large" | "amount_currency_conflict" | "amount_both_debit_credit"
  | "amount_negative_debit_credit" | "amount_float_rounded" | "direction_conflict" | "decimal_ambiguous" | "sign_convention_unconfirmed"
  // other fields
  | "description_missing" | "description_too_long" | "foreign_currency_row" | "currency_unknown" | "currency_not_storable" | "pending"
  | "low_confidence" | "balance_mismatch" | "type_unknown"
  // duplicates and relations
  | "duplicate_bank_reference" | "duplicate_overlap" | "possible_duplicate" | "repeated_bank_reference_in_file" | "possible_transfer"
  | "card_payment" | "refund_or_reversal" | "account_missing"
  // structure
  | "summary_row" | "continuation_merged" | "date_order_conflict" | "decimal_conflict" | "repeated_header_skipped" | "repeated_row_in_file"
  // OCR
  | "ocr_unverified" | "ocr_page_failed"
  // provenance
  | "edited_by_user";

export type CanonicalField =
  | "transactionDate" | "postingDate" | "description" | "amount" | "direction" | "currency" | "balance" | "bankReference" | "category" | "account" | "status";

/** Where a record came from, so it can be traced back to the original document. */
export interface SourceRef {
  format: SourceFormat;
  /** SHA-256 of the original file bytes. */
  fileSha256: string;
  filename: string;
  sheet?: string;
  /** 1-based page (PDF, OCR). */
  page?: number;
  /** 1-based row/line number in the original file or sheet. */
  row: number;
  /** Position on the page image (OCR only), pixels from the top-left of the upright page. */
  box?: { x: number; y: number; width: number; height: number };
}

export interface AccountRef {
  /**
   * Stable key used to scope duplicate detection and balances: institution, last four digits
   * and kind. Full account numbers are never stored or put in a key.
   */
  key: string | null;
  institution: string | null;
  last4: string | null;
  kind: AccountKind;
  country: string | null;
}

export interface CanonicalTransaction {
  schemaVersion: typeof SCHEMA_VERSION;
  /** Stable within an import draft ("r12", "ofx:0:3"). */
  id: string;
  source: SourceRef;
  /** The original cell values by source column header (or "column N"), exactly as read. */
  raw: Record<string, string>;
  account: AccountRef;
  transactionDate: IsoDate | null;
  postingDate: IsoDate | null;
  originalDescription: string;
  normalizedMerchant: string | null;
  /** Signed, in the currency's minor unit. Null when it could not be read (never guessed). */
  amountMinor: number | null;
  /** ISO 4217 code. */
  currency: string | null;
  currencyExponent: number;
  direction: Direction | null;
  balanceMinor: number | null;
  /** The bank's own transaction id (OFX FITID, a reference column) when present. */
  bankReference: string | null;
  category: Category | null;
  categorySource: CategorySource | null;
  pending: boolean;
  kindHints: KindHint[];
  /** 0..1 per field; 1 means read exactly from structured data. OCR lowers it. */
  confidence: Partial<Record<CanonicalField, number>>;
  issues: Issue[];
  status: ValidationStatus;
}

export interface BalanceObservation {
  amountMinor: number;
  on: IsoDate | null;
  /** Where the figure came from. Statement balances, transaction-derived balances and live balances are different things. */
  kind: "statement_closing" | "statement_opening" | "running_balance" | "derived";
}

export interface Reconciliation {
  accountKey: string | null;
  opening: BalanceObservation | null;
  closing: BalanceObservation | null;
  /** Sum of the statement's own rows (all of them, before duplicate skipping). */
  netMinor: number;
  /** opening + net - closing; 0 when it reconciles, null when it cannot be checked. */
  differenceMinor: number | null;
  /** Rows whose running balance does not follow from the previous row. */
  runningBalanceBreaks: string[];
  /**
   * Rows whose amount and direction are proven by the statement itself: the previous row's
   * balance plus this amount equals this row's balance (or the printed opening balance does, for
   * the first row), or the printed opening + all rows = printed closing balance.
   */
  balanceVerified: string[];
}

export const LOW_CONFIDENCE = 0.9;

export function issue(code: IssueCode, severity: IssueSeverity, field?: CanonicalField, vars?: Record<string, string | number>): Issue {
  return { code, severity, ...(field ? { field } : {}), ...(vars ? { vars } : {}) };
}

/** Errors reject; review issues need a decision; info never blocks. */
export function statusFor(issues: readonly Issue[]): ValidationStatus {
  if (issues.some((item) => item.severity === "error")) return "rejected";
  if (issues.some((item) => item.severity === "review")) return "needs_review";
  return "valid";
}

export function directionOf(amountMinor: number): Direction {
  return amountMinor < 0 ? "debit" : amountMinor > 0 ? "credit" : "zero";
}

export function accountKey(institution: string | null, last4: string | null, kind: AccountKind): string | null {
  if (!last4) return null;
  const bank = (institution ?? "").normalize("NFKC").trim().toLowerCase().replace(/\s+/g, " ");
  return `${bank}|${last4}|${kind}`;
}

export const UNKNOWN_ACCOUNT: AccountRef = { key: null, institution: null, last4: null, kind: "unknown", country: null };
