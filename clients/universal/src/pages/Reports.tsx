import type { PeriodPreset } from "@billie/shared-types";
import { buildSnapshot, localToday, resolvePeriod } from "@billie/finance-core";
import { excelReport, reportFilename, reportRows, transactionCsv } from "@billie/reporting";
import { useMemo, useState } from "react";
import { Empty, PageHeading, PeriodPicker } from "../components/common";
import { useFinance } from "../hooks/useFinance";
import { saveFile } from "../services/platform";

export function Reports() {
  const { transactions, statements, currency } = useFinance();
  const [preset, setPreset] = useState<PeriodPreset>("all_time");
  const [status, setStatus] = useState("");
  const cur = currency ?? "USD";
  const period = useMemo(() => resolvePeriod(preset, { today: localToday() }), [preset]);
  const rows = useMemo(() => reportRows(transactions, statements, period), [transactions, statements, period]);

  async function exportCsv() {
    const saved = await saveFile(reportFilename(period, localToday(), "csv"), new TextEncoder().encode(transactionCsv(rows)), "text/csv");
    setStatus(saved ? "CSV saved." : "Export cancelled.");
  }
  async function exportExcel() {
    const snapshot = buildSnapshot({ transactions, statements, period, currency: cur });
    const bytes = excelReport({ snapshot, rows, period, currency: cur, generatedOn: localToday() });
    const saved = await saveFile(reportFilename(period, localToday(), "xlsx"), bytes, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    setStatus(saved ? "Excel report saved." : "Export cancelled.");
  }

  if (transactions.length === 0) return <><PageHeading eyebrow="TAKE IT WITH YOU" title="Reports" /><Empty title="Nothing to export yet" body="Import a statement first." /></>;
  return (
    <>
      <PageHeading eyebrow="TAKE IT WITH YOU" title="Reports">
        <PeriodPicker value={preset} onChange={setPreset} />
      </PageHeading>
      <div className="bw-two-column">
        <section className="bw-panel bw-export">
          <h2>Categorized transactions (CSV)</h2>
          <p>Every transaction in the range with its category, ready for any spreadsheet. Text that a spreadsheet could run as a formula is neutralized.</p>
          <button className="bw-button bw-button-dark" onClick={exportCsv} disabled={rows.length === 0}>Export CSV</button>
        </section>
        <section className="bw-panel bw-export">
          <h2>Financial report (Excel)</h2>
          <p>Overview, monthly cash flow, spending by category, and all transactions in one .xlsx workbook.</p>
          <button className="bw-button bw-button-dark" onClick={exportExcel} disabled={rows.length === 0}>Export Excel</button>
        </section>
      </div>
      <p className="bw-caption">{rows.length} transactions in this range. Files are saved only where you choose.</p>
      <p role="status" aria-live="polite" className="bw-sr-status">{status}</p>
    </>
  );
}
