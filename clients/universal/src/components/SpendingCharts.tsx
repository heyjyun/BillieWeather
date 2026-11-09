// Spending charts for the Dashboard and Categories pages (same design as the website's
// app/views/finance/shared/_spending_*.html.erb). Every value shown on hover or focus is also
// in the list or table that comes with each chart.
import type { Category } from "@billie/shared-types";
import { formatMoney, OTHER_KEY, type CategoryTrend, type MerchantTotal, type SpendingMix, type SpendingMonth, type SpendingPart, type SpendingTone } from "@billie/finance-core";
import type { CSSProperties } from "react";
import { categoryLabel, useI18n } from "../i18n";

const toneClass = (tone: SpendingTone) => `bw-viz-${tone}`;

export function formatShare(share: number | null): string {
  if (share === null) return "—";
  return share > 0 && share < 0.005 ? "<1%" : `${Math.round(share * 100)}%`;
}

/** A clean top for a chart axis: the smallest 1, 2, 2.5 or 5 × 10ⁿ at or above `value`. */
export function axisMax(value: number): number {
  if (value <= 0) return 1;
  const step = 10 ** Math.floor(Math.log10(value));
  return [1, 2, 2.5, 5, 10].map((factor) => factor * step).find((top) => top >= value * 0.999999)!;
}

const wholeMoney = (cents: number, currency: string) => formatMoney(Math.round(cents / 100) * 100, currency).replace(/\.00$/, "");

function useLabels() {
  const { m, locale } = useI18n();
  const name = (key: SpendingPart["key"]) => (key === OTHER_KEY ? m.spending.other : categoryLabel(m, key));
  const monthFormat = new Intl.DateTimeFormat(locale, { month: "short", year: "numeric", timeZone: "UTC" });
  const month = (iso: string) => monthFormat.format(new Date(`${iso}T00:00:00Z`));
  return { name, month };
}

/** One whole (spending in a period) split into categories: a tall segmented bar, then a list naming every part. */
export function SpendingMixChart({ mix, currency, emptyText, onOpen }: { mix: SpendingMix; currency: string; emptyText: string; onOpen?: (category: Category) => void }) {
  const { t } = useI18n();
  const { name } = useLabels();
  if (mix.parts.length === 0) return <p className="bw-muted bw-viz-empty">{emptyText}</p>;
  return (
    <>
      <div className="bw-mix" role="list" aria-label={t("spending.mixLabel", { total: formatMoney(mix.totalCents, currency) })}>
        {mix.parts.map((part) => {
          const share = formatShare(part.share);
          return (
            <div key={part.key} className={`bw-mix-part ${toneClass(part.tone)}`} role="listitem" tabIndex={0} style={{ flexGrow: part.share ?? 0 }}
              aria-label={t("spending.partLabel", { name: name(part.key), amount: formatMoney(part.amountCents, currency), share })}>
              {(part.share ?? 0) >= 0.1 && <span className="bw-mix-value" aria-hidden="true">{share}</span>}
              <span className="bw-viz-tip" aria-hidden="true"><strong>{formatMoney(part.amountCents, currency)}</strong><span>{name(part.key)} · {share}</span></span>
            </div>
          );
        })}
      </div>
      <ul className="bw-mix-list">
        {mix.parts.map((part) => (
          <li key={part.key}>
            <i className={`bw-viz-swatch ${toneClass(part.tone)}`} aria-hidden="true" />
            <span className="bw-mix-name">
              {onOpen && part.key !== OTHER_KEY ? <button type="button" className="bw-link-button bw-mix-link" onClick={() => onOpen(part.key)}>{name(part.key)}</button> : name(part.key)}
              {part.members && <small>{part.members.slice(0, 4).map(name).join(", ")}{part.members.length > 4 ? "…" : ""}</small>}
            </span>
            <span className="bw-mix-share">{formatShare(part.share)}</span>
            <strong className="bw-mix-amount">{formatMoney(part.amountCents, currency)}</strong>
          </li>
        ))}
      </ul>
    </>
  );
}

const at = (value: number) => ({ "--at": value }) as CSSProperties;

function Axis({ top, currency }: { top: number; currency: string }) {
  return (
    <div className="bw-col-axis" aria-hidden="true">
      <span style={at(1)}>{wholeMoney(top, currency)}</span>
      <span style={at(0.5)}>{wholeMoney(top / 2, currency)}</span>
      <span style={at(0)}>{wholeMoney(0, currency)}</span>
    </div>
  );
}

const sortKey = (tone: SpendingTone) => (tone === "other" ? 100 : tone === "uncategorized" ? 101 : tone);

/** Spending per month, stacked by category in one order, with a legend, readouts and a table. */
export function MonthlySpendingChart({ months, currency }: { months: SpendingMonth[]; currency: string }) {
  const { m, t } = useI18n();
  const { name, month: monthName } = useLabels();
  const keys = [...new Map(months.flatMap((month) => month.segments).map((segment) => [segment.key, segment])).values()].sort((a, b) => sortKey(a.tone) - sortKey(b.tone));
  if (keys.length === 0) return <p className="bw-muted bw-viz-empty">{m.spending.noMonthly}</p>;
  const top = axisMax(Math.max(...months.map((month) => month.totalCents)));
  return (
    <>
      <ul className="bw-viz-legend" aria-label={m.spending.legend}>
        {keys.map((segment) => <li key={segment.key}><i className={`bw-viz-swatch ${toneClass(segment.tone)}`} aria-hidden="true" />{name(segment.key)}</li>)}
      </ul>
      <div className="bw-col-chart">
        <Axis top={top} currency={currency} />
        <div className="bw-col-plot">
          <i className="bw-col-grid" style={at(1)} aria-hidden="true" />
          <i className="bw-col-grid" style={at(0.5)} aria-hidden="true" />
          <ol className="bw-col-list" aria-label={m.spending.monthlyLabel}>
            {months.map((month) => (
              <li key={month.month} className="bw-col" tabIndex={0} aria-label={t("spending.monthLabel", { month: monthName(month.month), amount: formatMoney(month.totalCents, currency) })}>
                <span className="bw-col-bar">
                  <span className="bw-col-stack" style={{ height: `${(month.totalCents / top) * 100}%` }}>
                    {month.segments.map((segment) => <span key={segment.key} className={toneClass(segment.tone)} style={{ flexGrow: segment.amountCents / month.totalCents }} />)}
                  </span>
                </span>
                <span className="bw-col-month" aria-hidden="true">{monthName(month.month)}</span>
                <span className="bw-viz-tip bw-viz-tip-list" aria-hidden="true">
                  <span className="bw-viz-tip-title">{monthName(month.month)} · <strong>{formatMoney(month.totalCents, currency)}</strong></span>
                  {[...month.segments].reverse().map((segment) => (
                    <span key={segment.key} className="bw-viz-tip-row"><i className={`bw-viz-key ${toneClass(segment.tone)}`} /><strong>{formatMoney(segment.amountCents, currency)}</strong> {name(segment.key)}</span>
                  ))}
                </span>
              </li>
            ))}
          </ol>
        </div>
      </div>
      <details className="bw-chart-details">
        <summary>{m.spending.viewFigures}</summary>
        <div className="bw-table-scroll">
          <table className="bw-viz-table">
            <thead><tr><th scope="col">{m.spending.month}</th>{keys.map((segment) => <th key={segment.key} scope="col">{name(segment.key)}</th>)}<th scope="col">{m.spending.total}</th></tr></thead>
            <tbody>
              {months.map((month) => {
                const amounts = new Map(month.segments.map((segment) => [segment.key, segment.amountCents]));
                return (
                  <tr key={month.month}>
                    <th scope="row">{monthName(month.month)}</th>
                    {keys.map((segment) => <td key={segment.key}>{formatMoney(amounts.get(segment.key) ?? 0, currency)}</td>)}
                    <td><strong>{formatMoney(month.totalCents, currency)}</strong></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </details>
    </>
  );
}

/** One category at a glance: typical month, latest month against it, a trend with the average marked, and its biggest merchants. */
export function CategoryInsights({ trend, merchants, tone, spentCents, currency }: { trend: CategoryTrend; merchants: MerchantTotal[]; tone: SpendingTone; spentCents: number; currency: string }) {
  const { m, t } = useI18n();
  const { month: monthName } = useLabels();
  const s = m.spending;
  const color = typeof tone === "number" ? toneClass(tone) : "bw-viz-solo";
  const { averageCents, latest } = trend;
  let comparison = s.vsNone;
  if (averageCents && latest) {
    const change = Math.round(((latest.amountCents - averageCents) / averageCents) * 100);
    comparison = Math.abs(change) < 5 ? s.vsSame : t(change > 0 ? "spending.vsAbove" : "spending.vsBelow", { percent: `${Math.abs(change)}%` });
  }
  const peak = Math.max(0, ...trend.months.map((month) => month.amountCents));
  const top = axisMax(peak);
  return (
    <div className="bw-cat-insights">
      <div className="bw-cat-stats">
        <div className="bw-cat-stat"><span>{s.statTotal}</span><strong>{formatMoney(spentCents, currency)}</strong><small>{s.statTotalNote}</small></div>
        <div className="bw-cat-stat"><span>{s.statAverage}</span><strong>{averageCents ? formatMoney(averageCents, currency) : "—"}</strong><small>{t("spending.statAverageNote", { count: trend.months.length })}</small></div>
        <div className="bw-cat-stat">
          <span>{latest ? t("spending.statLatest", { month: monthName(latest.month) }) : s.statLatestNone}</span>
          <strong>{latest ? formatMoney(latest.amountCents, currency) : "—"}</strong>
          <small>{comparison}</small>
        </div>
      </div>
      <div className="bw-two-column bw-cat-charts">
        <section aria-labelledby="trend-heading">
          <h3 id="trend-heading" className="bw-viz-heading">{s.trendTitle}</h3>
          <p className="bw-viz-sub">{t("spending.trendBody", { count: trend.months.length })}</p>
          {peak === 0 ? <p className="bw-muted bw-viz-empty">{s.noCategorySpending}</p> : (
            <>
              <div className="bw-col-chart bw-col-chart-dense">
                <Axis top={top} currency={currency} />
                <div className="bw-col-plot">
                  <i className="bw-col-grid" style={at(1)} aria-hidden="true" />
                  <i className="bw-col-grid" style={at(0.5)} aria-hidden="true" />
                  {averageCents ? <i className="bw-col-average" style={at(averageCents / top)} aria-hidden="true"><span>{t("spending.averageLine", { amount: wholeMoney(averageCents, currency) })}</span></i> : null}
                  <ol className="bw-col-list" aria-label={s.trendLabel}>
                    {trend.months.map((month, index) => (
                      <li key={month.month} className="bw-col" tabIndex={0} aria-label={t("spending.monthLabel", { month: monthName(month.month), amount: formatMoney(month.amountCents, currency) })}>
                        <span className="bw-col-bar"><span className="bw-col-stack" style={{ height: `${(month.amountCents / top) * 100}%` }}>{month.amountCents > 0 && <span className={color} style={{ flexGrow: 1 }} />}</span></span>
                        <span className="bw-col-month" aria-hidden="true">{index % 2 === 0 || index === trend.months.length - 1 ? monthName(month.month) : ""}</span>
                        <span className="bw-viz-tip" aria-hidden="true"><strong>{formatMoney(month.amountCents, currency)}</strong><span>{monthName(month.month)}</span></span>
                      </li>
                    ))}
                  </ol>
                </div>
              </div>
              <details className="bw-chart-details">
                <summary>{s.viewFigures}</summary>
                <ul className="bw-viz-figures">{trend.months.map((month) => <li key={month.month}>{monthName(month.month)}: {formatMoney(month.amountCents, currency)}</li>)}</ul>
              </details>
            </>
          )}
        </section>
        <section aria-labelledby="merchants-heading">
          <h3 id="merchants-heading" className="bw-viz-heading">{s.merchantsTitle}</h3>
          <p className="bw-viz-sub">{s.merchantsBody}</p>
          {merchants.length === 0 ? <p className="bw-muted bw-viz-empty">{s.noCategorySpending}</p> : (
            <ol className="bw-rank-list">
              {merchants.map((merchant) => (
                <li key={merchant.name}>
                  <div className="bw-rank-row"><span className="bw-rank-name">{merchant.name} <small>{t("spending.merchantCount", { count: merchant.count })}</small></span><strong>{formatMoney(merchant.amountCents, currency)}</strong></div>
                  <div className="bw-rank-track" aria-hidden="true"><span className={color} style={{ width: `${(merchant.amountCents / merchants[0].amountCents) * 100}%` }} /></div>
                </li>
              ))}
            </ol>
          )}
        </section>
      </div>
    </div>
  );
}
