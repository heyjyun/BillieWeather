import { CURRENCIES, type Currency } from "@billie/shared-types";
import {
  allCategories, formatMoney, ImportError, ImportPipelineError, isPdf, normalizeRegion, reviseDraft, STATEMENT_REGIONS, templateFrom,
  type ImportContext, type ImportDraft, type ImportReport, type ReviewedPdfRow,
} from "@billie/finance-core";
import { useEffect, useState } from "react";
import { PageHeading } from "../components/common";
import { ImportPreview } from "../components/ImportPreview";
import { PdfReview, usePdfMessages } from "../components/PdfReview";
import { useFinance } from "../hooks/useFinance";
import { interpolate, useI18n } from "../i18n";
import importErrors from "../i18n/importErrors.json";
import { randomId } from "../services/ids";
import { importFile, importPdfReview, type ImportedFile, type PdfReview as Review } from "../services/importFile";
import { StoreError, type FinanceStore } from "../services/store";
import { commitDraft, ImportBlockedError, importContext, importDraftFile, importScannedPdf, UNIVERSAL_ACCEPT } from "../services/universalImport";

type History = Awaited<ReturnType<FinanceStore["importHistory"]>>;

/** Display name of a region code in the interface language ("" = not specified). Never detected from the device. */
function useRegionName() {
  const { m, locale } = useI18n();
  return (code: string | null): string => {
    if (!code) return m.universal.region.none;
    if (code === "CN") return m.universal.region.mainlandChina; // like the website: Mainland China, alongside HK, MO and TW
    try {
      return new Intl.DisplayNames([locale], { type: "region" }).of(code) ?? code;
    } catch {
      return code;
    }
  };
}

/** The optional Country / Region dropdown. "" means Not specified. */
function RegionSelect({ value, onChange, disabled, label }: { value: string; onChange: (code: string) => void; disabled?: boolean; label: string }) {
  const { m } = useI18n();
  const name = useRegionName();
  return (
    <select aria-label={label} value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)}>
      <option value="">{m.universal.region.none}</option>
      {STATEMENT_REGIONS.map((code) => <option key={code} value={code}>{name(code)}</option>)}
    </select>
  );
}

export function Import() {
  const { m, t, locale } = useI18n();
  const pdf = usePdfMessages();
  const { store, refresh, currency: deviceCurrency, statements, customCategories } = useFinance();
  const [currency, setCurrency] = useState<Currency>(deviceCurrency ?? "USD");
  // Optional; starts as Not specified for every visit and is never guessed.
  const [region, setRegion] = useState("");
  const [editingRegion, setEditingRegion] = useState<{ key: string; value: string } | null>(null);
  const regionName = useRegionName();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: "ok" | "warn" | "error"; text: string } | null>(null);
  // Files waiting for review, first one shown. Kept in memory only; nothing is written until confirmed.
  const [drafts, setDrafts] = useState<Array<{ draft: ImportDraft; context: ImportContext }>>([]);
  const [reviews, setReviews] = useState<Review[]>([]);
  const [reviewError, setReviewError] = useState<string | null>(null);
  const [history, setHistory] = useState<History>([]);
  const [reversing, setReversing] = useState<string | null>(null);
  // Set while an on-device OCR engine is reading; Stop aborts it and nothing is imported.
  const [recognition, setRecognition] = useState<AbortController | null>(null);
  const x = m.import;
  const u = m.universal;

  useEffect(() => {
    let live = true;
    void store.importHistory().then((items) => live && setHistory(items));
    return () => {
      live = false;
    };
  }, [store, statements]);

  function errorText(error: unknown): string {
    if (error instanceof ImportPipelineError) return u.errors[error.code] ?? x.genericError;
    if (error instanceof ImportBlockedError) return u.errors.blocked;
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
    const waitingPdf: Review[] = [];
    const waiting: Array<{ draft: ImportDraft; context: ImportContext }> = [];
    let failed = false;
    const cur = deviceCurrency ?? currency;
    const chosenRegion = normalizeRegion(region);
    for (const file of Array.from(files)) {
      try {
        const bytes = new Uint8Array(await file.arrayBuffer());
        if (isPdf(bytes, file.name)) {
          // Pages without a text layer are read by OCR; text pages keep the reviewed text extraction.
          const controller = new AbortController();
          setRecognition(controller);
          let scanned: Awaited<ReturnType<typeof importScannedPdf>> = null;
          try {
            scanned = await importScannedPdf(store, bytes, file.name, cur, controller.signal, chosenRegion);
          } finally {
            setRecognition(null);
          }
          if (scanned) waiting.push({ draft: scanned.draft, context: await importContext(store, chosenRegion) });
          if (scanned?.allPages) continue;
          // Text PDFs keep their own reviewed extraction (a port of the website's).
          const result = await importFile(store, bytes, file.name, cur, chosenRegion);
          if (result.kind === "review") {
            waitingPdf.push(result);
            lines.push(`${file.name}: ${pdf.backend("pdf_needs_review")}`);
          } else {
            lines.push(successText(file.name, result, cur));
          }
          continue;
        }
        const controller = new AbortController();
        setRecognition(controller);
        let draft: ImportDraft;
        try {
          draft = await importDraftFile(store, bytes, file.name, cur, controller.signal, chosenRegion);
        } finally {
          setRecognition(null);
        }
        waiting.push({ draft, context: await importContext(store, chosenRegion) });
      } catch (error) {
        failed = true;
        lines.push(t("import.failed", { file: file.name, message: errorText(error) }));
      }
    }
    await refresh();
    setBusy(false);
    setReviews((current) => [...current, ...waitingPdf]);
    setDrafts((current) => [...current, ...waiting]);
    if (lines.length > 0) setMessage({ tone: failed ? "error" : waitingPdf.length > 0 ? "warn" : "ok", text: lines.join(" ") });
    else setMessage(null);
  }

  /** After one import is saved, the others are re-checked against what is now stored (duplicates). */
  async function advance(rest: Array<{ draft: ImportDraft; context: ImportContext }>) {
    // Each waiting file keeps the region it was chosen with.
    const next = await Promise.all(rest.map(async (item) => {
      const context = await importContext(store, item.context.categorizer.region);
      return { draft: reviseDraft(item.draft, {}, context), context };
    }));
    setDrafts(next);
  }

  async function confirmDraft(draft: ImportDraft, context: ImportContext, template: { name: string } | null) {
    setBusy(true);
    setReviewError(null);
    try {
      if (template && draft.source.kind === "table" && draft.headerRow !== null) {
        await store.saveTemplate(templateFrom({ id: randomId(), name: template.name, institution: draft.preamble.institution, headers: draft.headers,
          mapping: draft.mapping, conventions: { ...draft.conventions, decimal: draft.effective.decimal, currency: draft.effective.currency }, now: new Date().toISOString() }));
      }
      const result = await commitDraft(store, draft, context);
      await refresh();
      const skipped = draft.rows.filter((row) => row.status !== "rejected").length - result.transactions;
      setMessage({ tone: "ok", text: interpolate(u.result, { file: draft.filename, count: result.transactions, skipped, rejected: draft.summary.rejected }) });
      await advance(drafts.slice(1));
    } catch (error) {
      setReviewError(errorText(error));
    } finally {
      setBusy(false);
    }
  }

  function cancelDraft(draft: ImportDraft) {
    setDrafts((current) => current.slice(1));
    setReviewError(null);
    setMessage({ tone: "ok", text: interpolate(u.cancelled, { file: draft.filename }) });
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

  async function reverse(item: History[number]) {
    setBusy(true);
    try {
      const removed = await store.reverseImport(item.statementIds);
      await refresh();
      setMessage({ tone: "ok", text: interpolate(u.history.reversed, { file: item.filename, count: removed }) });
    } catch (error) {
      setMessage({ tone: "error", text: errorText(error) });
    } finally {
      setReversing(null);
      setBusy(false);
    }
  }

  async function saveRegion(item: History[number], value: string) {
    setBusy(true);
    try {
      await store.setStatementRegion(item.statementIds, normalizeRegion(value));
      await refresh();
      setHistory(await store.importHistory()); // the statement list itself may be unchanged
      setEditingRegion(null);
      setMessage({ tone: "ok", text: interpolate(u.region.saved, { file: item.filename }) });
    } catch (error) {
      setMessage({ tone: "error", text: errorText(error) });
    } finally {
      setBusy(false);
    }
  }

  async function reclassify(item: History[number]) {
    setBusy(true);
    try {
      const count = await store.reclassifyStatements(item.statementIds);
      await refresh();
      setMessage({ tone: "ok", text: interpolate(u.region.reclassified, { file: item.filename, count }) });
    } catch (error) {
      setMessage({ tone: "error", text: errorText(error) });
    } finally {
      setBusy(false);
    }
  }

  const reportLine = (reports: ImportReport[]) => {
    const sum = (pick: (report: ImportReport) => number) => reports.reduce((total, report) => total + pick(report), 0);
    return interpolate(u.history.report, { accepted: sum((r) => r.accepted), duplicates: sum((r) => r.skippedDuplicates), rejected: sum((r) => r.rejected.length) });
  };

  const [current] = drafts;
  const [currentPdf] = reviews;
  return (
    <>
      <PageHeading eyebrow={x.eyebrow} title={x.title} />
      {current ? (
        <>
          {drafts.length + reviews.length > 1 && <p className="bw-message bw-message-warn" role="status">{interpolate(u.waiting, { count: drafts.length + reviews.length - 1 })}</p>}
          <ImportPreview key={current.draft.fileSha256} draft={current.draft} context={current.context} categories={allCategories(customCategories)} busy={busy} error={reviewError}
            onChange={(draft) => setDrafts((list) => [{ ...list[0], draft }, ...list.slice(1)])}
            onConfirm={(draft, template) => void confirmDraft(draft, current.context, template)} onCancel={() => cancelDraft(current.draft)} />
        </>
      ) : currentPdf ? (
        <>
          {reviews.length > 1 && <p className="bw-message bw-message-warn" role="status">{t("import.reviewQueued", { count: reviews.length - 1 })}</p>}
          <PdfReview key={currentPdf.sha256} review={currentPdf} busy={busy} error={reviewError}
            onConfirm={(rows) => void confirmReview(currentPdf, rows)} onCancel={() => cancelReview(currentPdf)} />
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
          <label className="bw-field"><span>{u.region.label}</span>
            <RegionSelect label={u.region.label} value={region} disabled={busy} onChange={setRegion} />
            <small>{u.region.help}</small>
          </label>
          <label className={`bw-dropzone ${busy ? "is-busy" : ""}`}>
            <input type="file" accept={`${UNIVERSAL_ACCEPT},.pdf,application/pdf`} multiple disabled={busy} onChange={(e) => { void onFiles(e.target.files); e.target.value = ""; }} />
            <strong>{recognition ? u.ocr.reading : busy ? x.importing : u.choose}</strong>
            <small>{u.requirements}</small>
          </label>
          {recognition && <button type="button" className="bw-button bw-button-outline bw-button-small" onClick={() => recognition.abort()}>{u.ocr.stop}</button>}
        </section>
      )}
      {message && <p className={`bw-message bw-message-${message.tone}`} role={message.tone === "error" ? "alert" : "status"}>{message.text}</p>}
      {history.length > 0 && (
        <section className="bw-panel">
          <h2>{u.history.title}</h2>
          <ul className="bw-simple-list">
            {history.map((item) => {
              const key = item.statementIds.join(",");
              const rejected = item.reports.flatMap((report) => report.rejected.map((row) => row.row));
              return (
                <li key={key}>
                  <strong>{item.filename}</strong>
                  {item.source === "web" && <span className="bw-tag">{m.sync.fromWeb}</span>}
                  {item.accounts.length > 0 && <span className="bw-tag bw-tag-muted">{item.accounts.join(", ")}</span>}
                  <small>{t("import.historyItem", { count: item.transactionCount, date: item.importedAt.slice(0, 10) })}</small>
                  <small className="bw-muted">{item.reports.length > 0 ? reportLine(item.reports) : u.history.legacy}</small>
                  {item.source === "local" && (editingRegion?.key === key ? (
                    <span role="group">
                      <RegionSelect label={u.region.label} value={editingRegion.value} disabled={busy} onChange={(value) => setEditingRegion({ key, value })} />{" "}
                      <button type="button" className="bw-button bw-button-small" disabled={busy} onClick={() => void saveRegion(item, editingRegion.value)}>{u.region.save}</button>{" "}
                      <button type="button" className="bw-link-button" onClick={() => setEditingRegion(null)}>{u.region.cancel}</button>
                    </span>
                  ) : (
                    <span>
                      <small className="bw-muted">{interpolate(u.region.tag, { region: regionName(item.region) })}</small>{" "}
                      <button type="button" className="bw-link-button" disabled={busy} onClick={() => setEditingRegion({ key, value: item.region ?? "" })}>{u.region.change}</button>{" "}
                      <button type="button" className="bw-link-button" disabled={busy} onClick={() => void reclassify(item)}>{u.region.reclassify}</button>
                    </span>
                  ))}
                  {rejected.length > 0 && <small className="bw-muted">{interpolate(u.history.rejectedRows, { rows: rejected.slice(0, 20).join(", ") })}</small>}
                  {item.source === "local" && (reversing === key ? (
                    <span role="group">
                      <small>{interpolate(u.history.reverseConfirm, { count: item.transactionCount })}</small>{" "}
                      <button type="button" className="bw-button bw-button-small bw-button-danger" disabled={busy} onClick={() => void reverse(item)}>{u.history.reverseYes}</button>{" "}
                      <button type="button" className="bw-link-button" onClick={() => setReversing(null)}>{u.history.reverseNo}</button>
                    </span>
                  ) : (
                    <button type="button" className="bw-link-button" disabled={busy} onClick={() => setReversing(key)}>{u.history.reverse}</button>
                  ))}
                </li>
              );
            })}
          </ul>
        </section>
      )}
    </>
  );
}
