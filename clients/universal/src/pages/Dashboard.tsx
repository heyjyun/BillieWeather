import type { PeriodPreset } from "@billie/shared-types";
import { buildSnapshot, localToday, resolvePeriod } from "@billie/finance-core";
import { useMemo, useState } from "react";
import { CategoryBadge, Empty, Money, PageHeading, PeriodPicker } from "../components/common";
import { useFinance } from "../hooks/useFinance";
import { useI18n } from "../i18n";
import type { Page } from "../App";

export function Dashboard({ go }: { go: (page: Page) => void }) {
  const { m, t } = useI18n();
  const { transactions, statements, currency } = useFinance();
  const [preset, setPreset] = useState<PeriodPreset>("all_time");
  const cur = currency ?? "USD";
  const period = useMemo(() => resolvePeriod(preset, { today: localToday() }), [preset]);
  const snap = useMemo(() => buildSnapshot({ transactions, statements, period, currency: cur }), [transactions, statements, period, cur]);
  const d = m.dashboard;

  if (transactions.length === 0) {
    return (
      <>
        <PageHeading eyebrow={d.eyebrow} title={d.title} />
        <Empty title={d.emptyTitle} body={d.emptyBody} action={<button className="bw-button bw-button-dark" onClick={() => go("import")}>{d.emptyAction}</button>} />
      </>
    );
  }
  const maxMonth = Math.max(1, ...snap.monthly.map((month) => Math.max(month.incomeCents, month.expensesCents)));
  return (
    <>
      <PageHeading eyebrow={d.eyebrow} title={d.title}><PeriodPicker value={preset} onChange={setPreset} /></PageHeading>
      <section className="bw-metrics" aria-label={d.totals}>
        <article className="bw-metric"><span>{d.income}</span><strong><Money cents={snap.incomeCents} currency={cur} /></strong></article>
        <article className="bw-metric"><span>{d.spending}</span><strong><Money cents={snap.expensesCents} currency={cur} /></strong></article>
        <article className="bw-metric"><span>{d.net}</span><strong><Money cents={snap.netCents} currency={cur} signed /></strong></article>
        <article className="bw-metric bw-metric-accent">
          <span>{d.balance}</span>
          <strong>{snap.balanceCents === null ? "—" : <Money cents={snap.balanceCents} currency={cur} />}</strong>
          <small>{snap.balanceOn ? t("dashboard.asOf", { date: snap.balanceOn }) : d.noBalance}</small>
        </article>
      </section>
      {snap.uncategorizedCount > 0 && <button className="bw-notice" onClick={() => go("transactions")}>{t("dashboard.needCategory", { count: snap.uncategorizedCount })}</button>}
      <div className="bw-two-column">
        <section className="bw-panel" aria-labelledby="monthly-heading">
          <h2 id="monthly-heading">{d.monthly}</h2>
          {snap.monthly.length === 0 ? <p className="bw-muted">{d.noCounted}</p> : (
            <ul className="bw-bars">
              {snap.monthly.map((month) => (
                <li key={month.month}>
                  <span className="bw-bar-label">{month.month.slice(0, 7)}</span>
                  <span className="bw-bar-track" aria-hidden="true">
                    <span className="bw-bar bw-bar-in" style={{ width: `${(month.incomeCents / maxMonth) * 100}%` }} />
                    <span className="bw-bar bw-bar-out" style={{ width: `${(month.expensesCents / maxMonth) * 100}%` }} />
                  </span>
                  <Money cents={month.netCents} currency={cur} signed />
                </li>
              ))}
            </ul>
          )}
          <p className="bw-legend"><span className="bw-dot bw-dot-in" /> {d.legendIncome} <span className="bw-dot bw-dot-out" /> {d.legendSpending}</p>
        </section>
        <section className="bw-panel" aria-labelledby="categories-heading">
          <h2 id="categories-heading">{d.byCategory}</h2>
          {snap.categories.length === 0 ? <p className="bw-muted">{d.noSpending}</p> : (
            <ul className="bw-category-list">
              {snap.categories.map((category) => (
                <li key={category.name}>
                  <CategoryBadge category={category.name} />
                  <span className="bw-share">{category.share === null ? "" : `${Math.round(category.share * 100)}%`}</span>
                  <Money cents={category.amountCents} currency={cur} />
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
      <section className="bw-panel" aria-labelledby="recent-heading">
        <h2 id="recent-heading">{d.recent}</h2>
        <ul className="bw-tx-list">
          {snap.recentTransactions.map((transaction) => (
            <li key={transaction.id} className={transaction.excluded ? "is-excluded" : ""}>
              <div><strong>{transaction.description}</strong><small>{transaction.bookedOn}</small></div>
              <CategoryBadge category={transaction.category} />
              <Money cents={transaction.amountCents} currency={cur} signed />
            </li>
          ))}
        </ul>
        <p className="bw-caption">{t("dashboard.notCounted", { transfers: snap.transferCount, excluded: snap.excludedCount })}</p>
      </section>
    </>
  );
}
