import type { PeriodPreset } from "@billie/shared-types";
import { buildSnapshot, localToday, resolvePeriod } from "@billie/finance-core";
import { useMemo, useState } from "react";
import { CategoryBadge, Empty, Money, PageHeading, PeriodPicker } from "../components/common";
import { useFinance } from "../hooks/useFinance";
import type { Page } from "../App";

export function Dashboard({ go }: { go: (page: Page) => void }) {
  const { transactions, statements, currency } = useFinance();
  const [preset, setPreset] = useState<PeriodPreset>("all_time");
  const cur = currency ?? "USD";
  const period = useMemo(() => resolvePeriod(preset, { today: localToday() }), [preset]);
  const snap = useMemo(() => buildSnapshot({ transactions, statements, period, currency: cur }), [transactions, statements, period, cur]);

  if (transactions.length === 0) {
    return (
      <>
        <PageHeading eyebrow="YOUR FINANCES, IN FOCUS" title="Dashboard" />
        <Empty title="No statements yet" body="Import a CSV statement from your bank to see income, spending, and cash flow. Everything stays on this device."
          action={<button className="bw-button bw-button-dark" onClick={() => go("import")}>Import a statement</button>} />
      </>
    );
  }
  const maxMonth = Math.max(1, ...snap.monthly.map((m) => Math.max(m.incomeCents, m.expensesCents)));
  return (
    <>
      <PageHeading eyebrow="YOUR FINANCES, IN FOCUS" title="Dashboard">
        <PeriodPicker value={preset} onChange={setPreset} />
      </PageHeading>
      <section className="bw-metrics" aria-label="Totals">
        <article className="bw-metric"><span>Income</span><strong><Money cents={snap.incomeCents} currency={cur} /></strong></article>
        <article className="bw-metric"><span>Spending</span><strong><Money cents={snap.expensesCents} currency={cur} /></strong></article>
        <article className="bw-metric"><span>Net cash flow</span><strong><Money cents={snap.netCents} currency={cur} signed /></strong></article>
        <article className="bw-metric bw-metric-accent">
          <span>Latest statement balance</span>
          <strong>{snap.balanceCents === null ? "—" : <Money cents={snap.balanceCents} currency={cur} />}</strong>
          <small>{snap.balanceOn ? `as of ${snap.balanceOn}` : "No balance column found yet"}</small>
        </article>
      </section>
      {snap.uncategorizedCount > 0 && (
        <button className="bw-notice" onClick={() => go("transactions")}>
          {snap.uncategorizedCount} transaction{snap.uncategorizedCount === 1 ? "" : "s"} need a category →
        </button>
      )}
      <div className="bw-two-column">
        <section className="bw-panel" aria-labelledby="monthly-heading">
          <h2 id="monthly-heading">Monthly cash flow</h2>
          {snap.monthly.length === 0 ? <p className="bw-muted">No counted transactions in this range.</p> : (
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
          <p className="bw-legend"><span className="bw-dot bw-dot-in" /> Income <span className="bw-dot bw-dot-out" /> Spending</p>
        </section>
        <section className="bw-panel" aria-labelledby="categories-heading">
          <h2 id="categories-heading">Spending by category</h2>
          {snap.categories.length === 0 ? <p className="bw-muted">No spending in this range.</p> : (
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
        <h2 id="recent-heading">Recent activity</h2>
        <ul className="bw-tx-list">
          {snap.recentTransactions.map((t) => (
            <li key={t.id} className={t.excluded ? "is-excluded" : ""}>
              <div><strong>{t.description}</strong><small>{t.bookedOn}</small></div>
              <CategoryBadge category={t.category} />
              <Money cents={t.amountCents} currency={cur} signed />
            </li>
          ))}
        </ul>
        <p className="bw-caption">Transfers and excluded transactions are not counted in totals. {snap.transferCount} transfer(s), {snap.excludedCount} excluded.</p>
      </section>
    </>
  );
}
