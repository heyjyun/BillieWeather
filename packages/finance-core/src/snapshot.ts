// Port of app/services/finance/snapshot.rb. Transfers and excluded rows never count
// toward income, spending, months, or categories.
import type { Category, CategoryTotal, Currency, IsoDate, MonthlyTotal, Period, Snapshot, Statement, Transaction } from "@billie/shared-types";

export const isCounted = (transaction: Transaction) => !transaction.excluded && transaction.category !== "Transfers";

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
  const months = new Map<IsoDate, MonthlyTotal>();
  const categories = new Map<Category, number>();
  for (const transaction of [...counted].sort((a, b) => (a.bookedOn < b.bookedOn ? -1 : a.bookedOn > b.bookedOn ? 1 : 0))) {
    const month = `${transaction.bookedOn.slice(0, 7)}-01`;
    const entry = months.get(month) ?? { month, incomeCents: 0, expensesCents: 0, netCents: 0 };
    if (transaction.amountCents > 0) {
      incomeCents += transaction.amountCents;
      entry.incomeCents += transaction.amountCents;
    } else if (transaction.amountCents < 0) {
      expensesCents -= transaction.amountCents;
      entry.expensesCents -= transaction.amountCents;
      categories.set(transaction.category, (categories.get(transaction.category) ?? 0) - transaction.amountCents);
    }
    entry.netCents = entry.incomeCents - entry.expensesCents;
    months.set(month, entry);
  }

  const categoryTotals: CategoryTotal[] = [...categories.entries()]
    .map(([name, amountCents]) => ({ name, amountCents, share: expensesCents > 0 ? amountCents / expensesCents : null }))
    .sort((a, b) => b.amountCents - a.amountCents || a.name.localeCompare(b.name));

  const dates = counted.map((transaction) => transaction.bookedOn).sort();
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
    transferCount: all.filter((transaction) => transaction.category === "Transfers" && !transaction.excluded).length,
    periodStart: dates[0] ?? null,
    periodEnd: dates[dates.length - 1] ?? null,
    categories: categoryTotals,
    monthly: [...months.values()],
    recentTransactions: [...all].sort(newestFirst).slice(0, 8),
    balanceCents: latestBalance?.closingBalanceCents ?? null,
    balanceOn: latestBalance?.closingBalanceOn ?? null,
  };
}

export { newestFirst };
