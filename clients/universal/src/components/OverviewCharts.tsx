import type { CategoryTotal, MonthlyTotal } from "@billie/shared-types";
import { categoryLabel, useI18n } from "../i18n";
import { overviewCopy } from "../i18n/overview";
import { Money } from "./common";

export function MonthlyCashFlow({ months, currency }: { months: MonthlyTotal[]; currency: string }) {
  const { locale, m } = useI18n();
  const copy = overviewCopy[locale];
  const recent = months.slice(-6);
  const max = Math.max(1, ...recent.flatMap((month) => [Math.abs(month.incomeCents), Math.abs(month.expensesCents)]));
  const formatter = new Intl.DateTimeFormat(locale, { month: "short", year: "numeric", timeZone: "UTC" });
  return (
    <section className="bw-panel bw-overview-trend" aria-labelledby="monthly-heading">
      <div className="bw-panel-top">
        <h2 id="monthly-heading">{copy.monthly}</h2>
        <p className="bw-legend"><span className="bw-dot bw-dot-in" /> {m.dashboard.legendIncome} <span className="bw-dot bw-dot-out" /> {m.dashboard.legendSpending}</p>
      </div>
      {recent.length === 0 && <p className="bw-muted">{m.dashboard.noCounted}</p>}
      <div className="bw-overview-months">
        {recent.map((month) => (
          <details className="bw-overview-month" key={month.month}>
            <summary>
              <span>{formatter.format(new Date(month.month + "T00:00:00Z"))}</span>
              <span className="bw-overview-bar-pair" aria-hidden="true">
                <i className="bw-overview-bar-in" style={{ width: (Math.abs(month.incomeCents) / max * 100) + "%" }} />
                <i className="bw-overview-bar-out" style={{ width: (Math.abs(month.expensesCents) / max * 100) + "%" }} />
              </span>
              <strong><Money cents={month.netCents} currency={currency} signed /></strong>
            </summary>
            <dl className="bw-overview-month-figures">
              <div><dt>{m.dashboard.income}</dt><dd><Money cents={month.incomeCents} currency={currency} /></dd></div>
              <div><dt>{m.dashboard.spending}</dt><dd><Money cents={month.expensesCents} currency={currency} /></dd></div>
            </dl>
          </details>
        ))}
      </div>
    </section>
  );
}

export function IncomeMix({ categories, currency }: { categories: CategoryTotal[]; currency: string }) {
  const { locale, m } = useI18n();
  const copy = overviewCopy[locale];
  return (
    <section className="bw-panel" aria-labelledby="income-categories-heading" id="dashboard-income-mix">
      <h2 id="income-categories-heading">{copy.incomeByCategory}</h2>
      {categories.length === 0 ? <p className="bw-muted">{copy.noIncome}</p> : (
        <ul className="bw-overview-income-list">
          {categories.map((entry) => (
            <li key={entry.name}>
              <span>{categoryLabel(m, entry.name)}</span>
              <strong><Money cents={entry.amountCents} currency={currency} /></strong>
              <i className="bw-overview-bar-in" aria-hidden="true" style={{ width: ((entry.share ?? 0) * 100) + "%" }} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
