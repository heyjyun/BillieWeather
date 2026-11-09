import { CURRENCIES, type Currency } from "@billie/shared-types";
import { formatMoney, ImportError, type ReviewedPdfRow } from "@billie/finance-core";
import { useState } from "react";
import { PageHeading } from "../components/common";
import { PdfReview, usePdfMessages } from "../components/PdfReview";
import { useFinance } from "../hooks/useFinance";
import { interpolate, useI18n } from "../i18n";
import importErrors from "../i18n/importErrors.json";
import { importFile, importPdfReview, type ImportedFile, type PdfReview as Review } from "../services/importFile";
import { StoreError } from "../services/store";

export function Import() {
  const { m, t, locale } = useI18n();
  const pdf = usePdfMessages();
  const { store, refresh, currency: deviceCurrency, statements } = useFinance();
  const [currency, setCurrency] = useState<Currency>(deviceCurrency ?? "USD");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: "ok" | "warn" | "error"; text: string } | null>(null);
  // PDFs waiting for review, first one shown. Kept in memory only.
  const [reviews, setReviews] = useState<Review[]>([]);
  const [reviewError, setReviewError] = useState<string | null>(null);
  const x = m.import;

  function errorText(error: unknown): string {
    if (error instanceof ImportError || error instanceof StoreError) {
      const translated = (importErrors as Record<string, Record<string, string>>)[locale]?.[error.code];
      if (translated) return interpolate(translated, error.vars);
    }
    return x.genericError;
  }

  function successText(filename: string, result: ImportedFile, cur: Currency): string {
    if (result.format === "pdf") return pdf.backend("pdf_imported_automatically", { count: result.count, filename });
    return result.closingBalanceCents === null
      ? t("import.success", { file: filename, count: result.count })
      : t("import.successBalance", { file: filename, count: result.count, balance: formatMoney(result.closingBalanceCents, cur) });
  }

  async function onFiles(files: FileList | null) {
    if (!files?.length) return;
    setBusy(true);
    const lines: string[] = [];
    const waiting: Review[] = [];
    let failed = false;
    const cur = deviceCurrency ?? currency;
    for (const file of Array.from(files)) {
      try {
        const result = await importFile(store, new Uint8Array(await file.arrayBuffer()), file.name, cur);
        if (result.kind === "review") {
          waiting.push(result);
          lines.push(`${file.name}: ${pdf.backend("pdf_needs_review")}`);
        } else {
          lines.push(successText(file.name, result, cur));
        }
      } catch (error) {
        failed = true;
        lines.push(t("import.failed", { file: file.name, message: errorText(error) }));
      }
    }
    await refresh();
    setBusy(false);
    setReviews((current) => [...current, ...waiting]);
    setMessage({ tone: failed ? "error" : waiting.length > 0 ? "warn" : "ok", text: lines.join(" ") });
  }

  async function confirmReview(review: Review, rows: ReviewedPdfRow[]) {
    setBusy(true);
    setReviewError(null);
    try {
      const result = await importPdfReview(store, review, rows);
      await refresh();
      setReviews((current) => current.filter((item) => item !== review));
      setMessage({ tone: "ok", text: `${review.filename}: ${pdf.backend("pdf_review_imported", { count: result.count })}` });
    } catch (error) {
      setReviewError(errorText(error));
    } finally {
      setBusy(false);
    }
  }

  function cancelReview(review: Review) {
    setReviews((current) => current.filter((item) => item !== review));
    setReviewError(null);
    setMessage({ tone: "ok", text: t("import.reviewDiscarded", { file: review.filename }) });
  }

  const [current] = reviews;
  return (
    <>
      <PageHeading eyebrow={x.eyebrow} title={x.title} />
      {current ? (
        <>
          {reviews.length > 1 && <p className="bw-message bw-message-warn" role="status">{t("import.reviewQueued", { count: reviews.length - 1 })}</p>}
          <PdfReview key={current.sha256} review={current} busy={busy} error={reviewError}
            onConfirm={(rows) => void confirmReview(current, rows)} onCancel={() => cancelReview(current)} />
        </>
      ) : (
        <section className="bw-panel bw-import">
          <p>{x.intro}</p>
          <label className="bw-field"><span>{x.currency}</span>
            <select value={deviceCurrency ?? currency} disabled={Boolean(deviceCurrency)} onChange={(e) => setCurrency(e.target.value as Currency)}>
              {CURRENCIES.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
            {deviceCurrency && <small>{x.currencyLocked}</small>}
          </label>
          <label className={`bw-dropzone ${busy ? "is-busy" : ""}`}>
            <input type="file" accept=".csv,text/csv,.pdf,application/pdf" multiple disabled={busy} onChange={(e) => { void onFiles(e.target.files); e.target.value = ""; }} />
            <strong>{busy ? x.importing : x.choose}</strong>
            <small>{x.requirements}</small>
          </label>
        </section>
      )}
      {message && <p className={`bw-message bw-message-${message.tone}`} role={message.tone === "error" ? "alert" : "status"}>{message.text}</p>}
      {statements.length > 0 && (
        <section className="bw-panel">
          <h2>{x.history}</h2>
          <ul className="bw-simple-list">
            {[...statements].reverse().map((statement) => (
              <li key={statement.id}>
                <strong>{statement.filename}</strong>
                {statement.source === "web" && <span className="bw-tag">{m.sync.fromWeb}</span>}
                <small>{t("import.historyItem", { count: statement.transactionCount, date: statement.importedAt.slice(0, 10) })}</small>
              </li>
            ))}
          </ul>
        </section>
      )}
    </>
  );
}
