// Types shared by every BillieWeather client. Mirrors the Rails models in
// app/models/finance/*.rb. Money is always integer minor units (cents) so that
// totals never suffer from floating-point rounding.

/** The built-in categories, the same on the website and in every app. */
export const CATEGORIES = [
  "Income",
  "Housing",
  "Food & dining",
  "Transport",
  "Utilities",
  "Shopping",
  "Health",
  "Business",
  "Transfers",
  "Uncategorized",
] as const;
export type BuiltInCategory = (typeof CATEGORIES)[number];
/**
 * A built-in category or one the person created (stored by name, like Rails'
 * Finance::CustomCategory). `string & {}` keeps editor suggestions for the built-in names.
 */
export type Category = BuiltInCategory | (string & {});

export const CURRENCIES = ["USD", "CAD", "EUR", "GBP", "AUD", "NZD", "SGD", "HKD", "CNY", "JPY"] as const;
export type Currency = (typeof CURRENCIES)[number];

/** ISO date, YYYY-MM-DD. */
export type IsoDate = string;

export interface Statement {
  id: number;
  filename: string;
  currency: Currency;
  sha256: string;
  transactionCount: number;
  closingBalanceCents: number | null;
  closingBalanceOn: IsoDate | null;
  importedAt: string;
  /** "web" = copied from the BillieWeather website; "local" = imported on this device. */
  source?: "local" | "web";
  /** Optional country/region chosen at import (two-letter code); null = not specified. */
  region?: string | null;
}

/** Economic meaning (packages/finance-core/schema/financial-schema.json). */
export type TransactionKind = "expense" | "income" | "refund" | "transfer" | "card_payment" | "opening_balance" | "adjustment" | "ignored";

export interface Transaction {
  id: number;
  statementId: number;
  bookedOn: IsoDate;
  description: string;
  amountCents: number;
  category: Category;
  taxReview: boolean;
  excluded: boolean;
  /**
   * Economic kind. Totals use it instead of the sign: refunds reduce spending, transfers and card
   * payments never count. Absent only for rows from older sources (then: Transfers category ->
   * transfer, positive -> income, otherwise expense).
   */
  kind?: TransactionKind;
  /** The account (accounts table) this entry belongs to. */
  accountId?: number | null;
  /** The bank's text exactly as imported; never edited. */
  originalDescription?: string;
  /** Where the entry came from: import, manual, web_copy, recurring, … */
  origin?: string;
  merchant?: string | null;
  project?: string | null;
  tags?: string[];
  note?: string | null;
  time?: string | null;
  /** Fields a person set; automation never changes them. */
  lockedFields?: string[];
  categorySource?: string;
}

/** "Remember my change": same merchant + same direction gets the same category. */
export interface MerchantRule {
  merchantKey: string;
  income: boolean;
  category: Exclude<Category, "Uncategorized">;
}

/** A parsed row before it is stored. */
export interface ParsedTransaction {
  bookedOn: IsoDate;
  description: string;
  amountCents: number;
  category: Category;
  taxReview: boolean;
  excluded: boolean;
}

export interface ParsedStatement {
  rows: ParsedTransaction[];
  closingBalanceCents: number | null;
  closingBalanceOn: IsoDate | null;
  dateColumnUsed: string | null;
}

export interface MonthlyTotal {
  month: IsoDate; // first day of month
  incomeCents: number;
  expensesCents: number;
  netCents: number;
}

export interface CategoryTotal {
  name: Category;
  amountCents: number;
  share: number | null;
}

export interface Snapshot {
  currency: Currency;
  incomeCents: number;
  expensesCents: number;
  netCents: number;
  transactionCount: number;
  statementCount: number;
  uncategorizedCount: number;
  taxReviewCount: number;
  excludedCount: number;
  transferCount: number;
  periodStart: IsoDate | null;
  periodEnd: IsoDate | null;
  categories: CategoryTotal[];
  monthly: MonthlyTotal[];
  recentTransactions: Transaction[];
  balanceCents: number | null;
  balanceOn: IsoDate | null;
}

export type PeriodPreset = "all_time" | "this_month" | "last_month" | "last_30_days" | "this_year" | "last_year" | "custom";

export interface Period {
  preset: PeriodPreset;
  startDate: IsoDate | null;
  endDate: IsoDate | null;
}

// The Feature Library catalog and preference rules (see ./modules.ts).
export * from "./modules";
