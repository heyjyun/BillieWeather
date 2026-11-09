// Port of Finance::Report.row_for: one export row per transaction, newest first.
import type { Currency, IsoDate, Period, Statement, Transaction } from "@billie/shared-types";
import { inPeriod, isCounted, merchantKey, newestFirst, titleizeMerchant } from "@billie/finance-core";

export interface ReportRow {
  bookedOn: IsoDate;
  account: string;
  merchant: string | null;
  description: string;
  category: string;
  amountCents: number;
  currency: Currency;
  taxReview: boolean;
  excluded: boolean;
  counted: boolean;
}

export function reportRows(transactions: readonly Transaction[], statements: readonly Statement[], period: Pick<Period, "startDate" | "endDate">): ReportRow[] {
  const byId = new Map(statements.map((statement) => [statement.id, statement]));
  return transactions.filter((transaction) => inPeriod(transaction, period)).sort(newestFirst).map((transaction) => {
    const statement = byId.get(transaction.statementId);
    return {
      bookedOn: transaction.bookedOn,
      account: statement?.filename ?? "",
      merchant: titleizeMerchant(merchantKey(transaction.description)),
      description: transaction.description,
      category: transaction.category,
      amountCents: transaction.amountCents,
      currency: statement?.currency ?? "USD",
      taxReview: transaction.taxReview,
      excluded: transaction.excluded,
      counted: isCounted(transaction),
    };
  });
}

export function reportFilename(period: Pick<Period, "startDate" | "endDate">, today: IsoDate, extension: "csv" | "xlsx"): string {
  const range = period.startDate && period.endDate ? `${period.startDate}-to-${period.endDate}` : "all-time";
  return `billieweather-report-${range}-${today}.${extension}`;
}
