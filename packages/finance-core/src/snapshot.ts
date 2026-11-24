// Port of app/services/finance/snapshot.rb. Transfers and excluded rows never count
// toward income, spending, months, or categories.
import type { Category, CategoryTotal, Currency, IsoDate, MonthlyTotal, Period, Snapshot, Statement, Transaction, TransactionKind } from "@billie/shared-types";

/** The stored kind, or the legacy rule for rows without one (financial-schema.json legacyKind). */
export const kindOf = (transaction: Transaction): TransactionKind =>
  transaction.kind ?? (transaction.category === "Transfers" ? "transfer" : transaction.amountCents > 0 ? "income" : "expense");

/** Counted in income/expense totals: only income, expense and refund kinds, never excluded rows. */
export const isCounted = (transaction: Transaction) => !transaction.excluded && ["income", "expense", "refund"].includes(kindOf(transaction));

export function inPeriod(transaction: Transaction, period: Pick<Period, "startDate" | "endDate">): boolean {
  return (!period.startDate || transaction.bookedOn >= period.startDate) && (!period.endDate || transaction.bookedOn <= period.endDate);
}

const newestFirst = (a: Transaction, b: Transaction) => (a.bookedOn === b.bookedOn ? b.id - a.id : a.bookedOn < b.bookedOn ? 1 : -1);

export function buildSnapshot(input: {
  transactions: readonly Transaction[];
  statements: readonly Statement[];
  period: Pick<Period, "startDate" | "endDate">;
  currency: Currency;
}): Snapshot {
  const filtered = Boolean(input.period.startDate || input.period.endDate);
  const all = input.transactions.filter((transaction) => inPeriod(transaction, input.period));
  const counted = all.filter(isCounted);

  let incomeCents = 0;
  let expensesCents = 0;
  let periodStart: IsoDate | null = null;
  let periodEnd: IsoDate | null = null;
  const months = new Map<IsoDate, MonthlyTotal>();
  const categories = new Map<Category, number>();
  const incomeCategories = new Map<Category, number>();
  for (const transaction of counted) {
    if (periodStart === null || transaction.bookedOn < periodStart) periodStart = transaction.bookedOn;
    if (periodEnd === null || transaction.bookedOn > periodEnd) periodEnd = transaction.bookedOn;
    const month = `${transaction.bookedOn.slice(0, 7)}-01`;
    const entry = months.get(month) ?? { month, incomeCents: 0, expensesCents: 0, netCents: 0 };
    // Income and expense come from the kind; a refund (money in) reduces spending in its category.
    if (kindOf(transaction) === "income") {
      incomeCents += transaction.amountCents;
      entry.incomeCents += transaction.amountCents;
      incomeCategories.set(transaction.category, (incomeCategories.get(transaction.category) ?? 0) + transaction.amountCents);
    } else if (transaction.amountCents !== 0) {
      expensesCents -= transaction.amountCents;
      entry.expensesCents -= transaction.amountCents;
      categories.set(transaction.category, (categories.get(transaction.category) ?? 0) - transaction.amountCents);
    }
    entry.netCents = entry.incomeCents - entry.expensesCents;
    months.set(month, entry);
  }

  const categoryTotals: CategoryTotal[] = [...categories.entries()]
    .filter(([, amountCents]) => amountCents !== 0)
    .map(([name, amountCents]) => ({ name, amountCents, share: expensesCents > 0 ? amountCents / expensesCents : null }))
    .sort((a, b) => b.amountCents - a.amountCents || a.name.localeCompare(b.name));

  const latestBalance = [...input.statements]
    .filter((statement) => statement.closingBalanceCents !== null && statement.closingBalanceOn !== null)
    .sort((a, b) => (a.closingBalanceOn! < b.closingBalanceOn! ? 1 : a.closingBalanceOn! > b.closingBalanceOn! ? -1 : b.id - a.id))[0];

  return {
    currency: input.currency,
    incomeCents,
    expensesCents,
    netCents: incomeCents - expensesCents,
    transactionCount: all.length,
    statementCount: filtered ? new Set(all.map((transaction) => transaction.statementId)).size : input.statements.length,
    uncategorizedCount: counted.filter((transaction) => transaction.category === "Uncategorized").length,
    taxReviewCount: all.filter((transaction) => transaction.taxReview && !transaction.excluded).length,
    excludedCount: all.filter((transaction) => transaction.excluded).length,
    transferCount: all.filter((transaction) => ["transfer", "card_payment"].includes(kindOf(transaction)) && !transaction.excluded).length,
    periodStart,
    periodEnd,
    categories: categoryTotals,
    incomeCategories: [...incomeCategories.entries()].filter(([, amountCents]) => amountCents > 0)
      .map(([name, amountCents]) => ({ name, amountCents, share: incomeCents > 0 ? amountCents / incomeCents : null }))
      .sort((a, b) => b.amountCents - a.amountCents || a.name.localeCompare(b.name)),
    monthly: [...months.values()].sort((a, b) => a.month.localeCompare(b.month)),
    recentTransactions: [...all].sort(newestFirst).slice(0, 8),
    balanceCents: latestBalance?.closingBalanceCents ?? null,
    balanceOn: latestBalance?.closingBalanceOn ?? null,
  };
}

export { newestFirst };
