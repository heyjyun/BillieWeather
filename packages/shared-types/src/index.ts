// Types shared by every BillieWeather client. Mirrors the Rails models in
// app/models/finance/*.rb. Money is always integer minor units (cents) so that
// totals never suffer from floating-point rounding.

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
export type Category = (typeof CATEGORIES)[number];

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
}

export interface Transaction {
  id: number;
  statementId: number;
  bookedOn: IsoDate;
  description: string;
  amountCents: number;
  category: Category;
  taxReview: boolean;
  excluded: boolean;
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
