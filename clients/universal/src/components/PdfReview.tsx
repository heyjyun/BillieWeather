// Review of a PDF statement before import, like the website's review page: every row can
// be corrected or left out, and nothing is saved until the person confirms.
import { PDF_GENERIC_NOTICES, type PdfWarning, type ReviewedPdfRow } from "@billie/finance-core";
import { useMemo, useState, type FormEvent } from "react";
import { interpolate, useI18n } from "../i18n";
import importErrors from "../i18n/importErrors.json";
import pdfReview from "../i18n/pdfReview.json";
import type { PdfReview as Review } from "../services/importFile";

type Messages = Record<string, Record<string, string>>;
const AMOUNT_WARNINGS = new Set(["pdf_amount_currency", "pdf_amount_markers", "pdf_amount_unsigned", "pdf_amount_limit", "pdf_amount_unreadable"]);

export function usePdfMessages() {
  const { locale } = useI18n();
  return useMemo(() => {
    const errors = (importErrors as Messages)[locale] ?? (importErrors as Messages).en;
    const review = (pdfReview as Messages)[locale] ?? (pdfReview as Messages).en;
    const backend = (code: string, vars: Record<string, string | number> = {}) => (errors[code] ? interpolate(errors[code], vars) : "");
    /** Rails shows amount problems as "Row N: <problem>". */
    const warning = (item: PdfWarning) => AMOUNT_WARNINGS.has(item.code)
      ? backend("pdf_row_warning", { row: item.vars.row, warning: backend(item.code, item.vars) })
      : backend(item.code, item.vars);
    const ui = (key: string, vars: Record<string, string | number> = {}) => interpolate(review[key], vars);
    return { backend, warning, ui };
  }, [locale]);
}

export function PdfReview({ review, busy, error, onConfirm, onCancel }: {
  review: Review;
  busy: boolean;
  error: string | null;
  onConfirm: (rows: ReviewedPdfRow[]) => void;
  onCancel: () => void;
}) {
  const { ui, warning } = usePdfMessages();
  const [rows, setRows] = useState<ReviewedPdfRow[]>(() => review.draft.rows.map((row) => ({ ...row, include: true })));
  const [confirmed, setConfirmed] = useState(false);
  const flagged = useMemo(() => new Set(review.draft.warnings.flatMap((item) => (typeof item.vars.row === "number" ? [item.vars.row] : []))), [review]);
  const notes = review.draft.warnings;
  const specific = notes.filter((item) => !(PDF_GENERIC_NOTICES as readonly string[]).includes(item.code));

  function update(index: number, change: Partial<ReviewedPdfRow>) {
    setRows((current) => current.map((row, i) => (i === index ? { ...row, ...change } : row)));
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    if (confirmed && !busy) onConfirm(rows);
  }

  return (
    <form className="bw-pdf-review" onSubmit={submit} aria-labelledby="pdf-review-title">
      <section className="bw-panel">
        <span className="bw-eyebrow">{ui("eyebrow")}</span>
        <h2 id="pdf-review-title">{ui("title")}</h2>
        <p className="bw-muted">{review.filename} · {review.currency}</p>
        <h3>{ui("noticeTitle")}</h3>
        <p>{ui("notice")}</p>
        {specific.length > 0 && (
          <ul className="bw-pdf-warnings">
            {specific.map((item, index) => <li key={index}>{warning(item)}</li>)}
          </ul>
        )}
        <details>
          <summary>{ui("notes", { count: notes.length })}</summary>
          <ul>{notes.map((item, index) => <li key={index}>{warning(item)}</li>)}</ul>
        </details>
      </section>

      <section className="bw-panel">
        <h2>{ui("rows")} <span className="bw-tag">{rows.length}</span></h2>
        <p className="bw-muted">{ui("rowsHint")}</p>
        <div className="bw-table-scroll">
          <table className="bw-review-table">
            <thead>
              <tr>
                <th scope="col">{ui("include")}</th>
                <th scope="col">{ui("date")}</th>
                <th scope="col">{ui("description")}</th>
                <th scope="col">{ui("amount", { currency: review.currency })}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row, index) => {
                const number = index + 1;
                return (
                  <tr key={index} className={flagged.has(number) || row.amount === "" ? "is-flagged" : undefined}>
                    <td><input type="checkbox" checked={row.include} aria-label={ui("includeRow", { number })} onChange={(e) => update(index, { include: e.target.checked })} /></td>
                    <td><input type="date" value={row.bookedOn} required={row.include} aria-label={ui("rowDate", { number })} onChange={(e) => update(index, { bookedOn: e.target.value })} /></td>
                    <td><input type="text" value={row.description} maxLength={500} required={row.include} aria-label={ui("rowDescription", { number })} onChange={(e) => update(index, { description: e.target.value })} /></td>
                    <td><input type="text" inputMode="decimal" value={row.amount} required={row.include} placeholder={ui("amountPlaceholder")} aria-label={ui("rowAmount", { number })} onChange={(e) => update(index, { amount: e.target.value })} /></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      <label className="bw-panel bw-check bw-review-confirm">
        <input type="checkbox" checked={confirmed} required onChange={(e) => setConfirmed(e.target.checked)} />
        <span><strong>{ui("confirm")}</strong><br /><small className="bw-muted">{ui("confirmHint")}</small></span>
      </label>
      {error && <p className="bw-message bw-message-error" role="alert">{error}</p>}
      <div className="bw-review-actions">
        <button type="button" className="bw-button bw-button-outline" disabled={busy} onClick={onCancel}>{ui("cancel")}</button>
        <button type="submit" className="bw-button bw-button-dark" disabled={busy || !confirmed}>{ui("submit")}</button>
      </div>
    </form>
  );
}
