import type { PeriodPreset } from "@billie/shared-types";
import { buildSnapshot, localToday, resolvePeriod } from "@billie/finance-core";
import { excelReport, reportFilename, reportRows, transactionCsv } from "@billie/reporting";
import { useMemo, useState } from "react";
import { Empty, PageHeading, PeriodPicker } from "../components/common";
import { useFinance } from "../hooks/useFinance";
import { useI18n } from "../i18n";
import { saveFile } from "../services/platform";

export function Reports() {
  const { m, t } = useI18n();
  const { transactions, statements, currency } = useFinance();
  const [preset, setPreset] = useState<PeriodPreset>("all_time");
  const [status, setStatus] = useState("");
  const cur = currency ?? "USD";
  const period = useMemo(() => resolvePeriod(preset, { today: localToday() }), [preset]);
  const rows = useMemo(() => reportRows(transactions, statements, period), [transactions, statements, period]);
  const x = m.reports;

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
      <p role="status" aria-live="polite" className="bw-sr-status">{status}</p>
    </>
  );
}
