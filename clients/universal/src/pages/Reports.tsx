import type { PeriodPreset } from "@billie/shared-types";
import { buildSnapshot, DIRECT_SUFFIX, localToday, resolvePeriod } from "@billie/finance-core";
import { excelReport, reportFilename, reportRows, transactionCsv } from "@billie/reporting";
import { useEffect, useMemo, useState } from "react";
import { Empty, Money, PageHeading, PeriodPicker } from "../components/common";
import { useFinance } from "../hooks/useFinance";
import { categoryLabel, useI18n } from "../i18n";
import { saveFile } from "../services/platform";

export function Reports() {
  const { m, t } = useI18n();
  const { transactions, statements, currency, store, accounts, categoryTree } = useFinance();
  const [dimension, setDimension] = useState<"category" | "account" | "merchant" | "project" | "tag" | "month">("category");
  // By category: top-level categories first; choosing one shows what is inside it (any depth).
  const [focus, setFocus] = useState<string | null>(null);
  const [report, setReport] = useState<Awaited<ReturnType<typeof store.ledger.report>> | null>(null);
  const [history, setHistory] = useState<Awaited<ReturnType<typeof store.ledger.netWorthHistory>>>([]);
  const [preset, setPreset] = useState<PeriodPreset>("all_time");
  const [status, setStatus] = useState("");
  const cur = currency ?? "USD";
  const period = useMemo(() => resolvePeriod(preset, { today: localToday() }), [preset]);
  const rows = useMemo(() => reportRows(transactions, statements, period), [transactions, statements, period]);
  const x = m.reports;
  const r = m.ledger.reports;
  useEffect(() => { void store.ledger.report(dimension, { from: period.startDate, to: period.endDate }, dimension === "category" ? focus : null).then(setReport); }, [store, dimension, period, transactions, focus]);
  const categoryName = (key: string) => (key.endsWith(DIRECT_SUFFIX) ? t("ledger.reports.direct", { name: categoryLabel(m, key.slice(0, -DIRECT_SUFFIX.length)) }) : categoryLabel(m, key));
  const drillable = (key: string) => !key.endsWith(DIRECT_SUFFIX) && (categoryTree.get(key)?.children.length ?? 0) > 0;
  useEffect(() => { void store.ledger.netWorthHistory(12).then(setHistory); }, [store, transactions, accounts]);

  // CSV keeps canonical English categories (same as the Rails export); Excel is translated.
  async function exportCsv() {
    const saved = await saveFile(reportFilename(period, localToday(), "csv"), new TextEncoder().encode(transactionCsv(rows)), "text/csv");
    setStatus(saved ? x.csvSaved : x.cancelled);
  }
  async function exportExcel() {
    const snapshot = buildSnapshot({ transactions, statements, period, currency: cur });
    const labels = { ...m.excel, disclaimer: m.footer, categoryNames: m.categories as Record<string, string> };
    const bytes = excelReport({ snapshot, rows, period, currency: cur, generatedOn: localToday(), labels });
    const saved = await saveFile(reportFilename(period, localToday(), "xlsx"), bytes, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    setStatus(saved ? x.xlsxSaved : x.cancelled);
  }

  if (transactions.length === 0) return <><PageHeading eyebrow={x.eyebrow} title={x.title} /><Empty title={x.emptyTitle} body={x.emptyBody} /></>;
  return (
    <>
      <PageHeading eyebrow={x.eyebrow} title={x.title}><PeriodPicker value={preset} onChange={setPreset} /></PageHeading>
      <div className="bw-two-column">
        <section className="bw-panel bw-export">
          <h2>{x.csvTitle}</h2>
          <p>{x.csvBody}</p>
          <button className="bw-button bw-button-dark" onClick={exportCsv} disabled={rows.length === 0}>{x.csvButton}</button>
        </section>
        <section className="bw-panel bw-export">
          <h2>{x.xlsxTitle}</h2>
          <p>{x.xlsxBody}</p>
          <button className="bw-button bw-button-dark" onClick={exportExcel} disabled={rows.length === 0}>{x.xlsxButton}</button>
        </section>
      </div>
      <p className="bw-caption">{t("reports.count", { count: rows.length })}</p>
      {report && (
        <section className="bw-panel bw-section-gap" aria-labelledby="dimension-heading">
          <h2 id="dimension-heading">{r.by}: {r.dimensions[dimension]}</h2>
          <div className="bw-segmented" role="group" aria-label={r.by}>
            {(Object.keys(r.dimensions) as Array<keyof typeof r.dimensions>).map((key) => (
              <button key={key} type="button" className={dimension === key ? "is-active" : ""} aria-pressed={dimension === key} onClick={() => setDimension(key)}>{r.dimensions[key]}</button>
            ))}
          </div>
          <div className="bw-metrics">
            <div className="bw-metric"><span>{r.income}</span><strong><Money cents={report.incomeMinor} currency={cur} /></strong></div>
            <div className="bw-metric"><span>{r.expense}</span><strong><Money cents={report.expenseMinor} currency={cur} /></strong></div>
            <div className="bw-metric bw-metric-accent"><span>{r.net}</span><strong><Money cents={report.netMinor} currency={cur} signed /></strong></div>
          </div>
          <div className="bw-table-scroll">
            <table className="bw-cat-table">
              {dimension === "category" && focus && (
                <caption>
                  {categoryTree.path(focus, (name) => categoryLabel(m, name))}{" "}
                  <button type="button" className="bw-link-button" onClick={() => setFocus(categoryTree.get(focus)?.parent ?? null)}>← {categoryTree.get(focus)?.parent ? categoryLabel(m, categoryTree.get(focus)!.parent!) : r.drillUp}</button>
                </caption>
              )}
              <thead><tr><th scope="col">{r.dimensions[dimension]}</th><th scope="col">{r.income}</th><th scope="col">{r.expense}</th><th scope="col">{r.count}</th></tr></thead>
              <tbody>
                {report.rows.map((row) => (
                  <tr key={row.key || "none"}>
                    <td>{row.key ? (dimension === "category" ? (drillable(row.key)
                      ? <button type="button" className="bw-link-button" aria-label={t("ledger.reports.drill", { name: categoryName(row.key) })} onClick={() => setFocus(row.key)}>{categoryName(row.key)} ›</button>
                      : categoryName(row.key)) : row.key) : r.unlabeled}</td>
                    <td><Money cents={row.incomeMinor} currency={cur} /></td>
                    <td><Money cents={row.expenseMinor} currency={cur} /></td>
                    <td>{row.count}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
      {accounts.length > 0 && history.length > 0 && (
        <section className="bw-panel bw-section-gap" aria-labelledby="networth-heading">
          <h2 id="networth-heading">{r.netWorthTitle}</h2>
          <div className="bw-table-scroll">
            <table className="bw-cat-table">
              <thead><tr><th scope="col">{r.month}</th><th scope="col">{r.assets}</th><th scope="col">{r.liabilities}</th><th scope="col">{r.netWorth}</th></tr></thead>
              <tbody>{history.map((row) => <tr key={row.month}><td>{row.month}</td><td><Money cents={row.assetsMinor} currency={cur} /></td><td><Money cents={row.liabilitiesMinor} currency={cur} /></td><td><Money cents={row.netWorthMinor} currency={cur} signed /></td></tr>)}</tbody>
            </table>
          </div>
        </section>
      )}
      <p role="status" aria-live="polite" className="bw-sr-status">{status}</p>
    </>
  );
}
