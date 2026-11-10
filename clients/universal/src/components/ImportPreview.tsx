// Preview -> Confirm for the universal import. Shows how the file was read, every setting that
// changes financial results (highlighted when the person must choose), the rows with their
// status and notes, and the reconciliation. Nothing is saved until "Import" is pressed, and that
// button stays disabled while anything is undecided.
import { CURRENCIES } from "@billie/shared-types";
import {
  commitPlan, decisionFor, formatMoney, MAPPED_FIELDS, minorToDecimalString, reviseDraft, suggestedDecision,
  type CanonicalTransaction, type ColumnMapping, type CommitBlocker, type Conventions, type DraftChange, type ImportContext, type ImportDraft, type MappedField, type RowEdit,
} from "@billie/finance-core";
import { useEffect, useMemo, useState } from "react";
import { categoryLabel, interpolate, useI18n } from "../i18n";

const ROW_LIMIT = 300;

function money(minor: number | null, exponent: number, currency: string | null): string {
  if (minor === null) return "—";
  // formatMoney works in scale-2 cents; convert exactly for display (JPY 1000 -> 100000 cents).
  const cents = exponent <= 2 ? minor * 10 ** (2 - exponent) : null;
  return cents !== null && currency ? formatMoney(cents, currency) : `${minorToDecimalString(minor, exponent)} ${currency ?? ""}`.trim();
}

export function ImportPreview(props: {
  draft: ImportDraft;
  context: ImportContext;
  categories: readonly string[];
  busy: boolean;
  error: string | null;
  onChange: (draft: ImportDraft) => void;
  onConfirm: (draft: ImportDraft, template: { name: string } | null) => void;
  onCancel: () => void;
}) {
  const { draft, context } = props;
  const { m } = useI18n();
  const u = m.universal;
  const [showAll, setShowAll] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [form, setForm] = useState<{ date: string; description: string; amount: string }>({ date: "", description: "", amount: "" });
  const [saveTemplate, setSaveTemplate] = useState(false);
  const [templateName, setTemplateName] = useState(draft.preamble.institution ?? draft.filename.replace(/\.[^.]+$/, ""));
  const t = (text: string, vars?: Record<string, string | number>) => interpolate(text, vars);
  const ocr = draft.ocr;
  const [shownPage, setShownPage] = useState(ocr?.images[0]?.page ?? 1);
  const [highlight, setHighlight] = useState<string | null>(null);
  // The original page image, kept in memory and shown as a data URL (no file, no upload).
  const pageImage = useMemo(() => {
    const image = ocr?.images.find((item) => item.page === shownPage);
    if (!image) return null;
    let binary = "";
    for (let start = 0; start < image.bytes.length; start += 0x8000) binary += String.fromCharCode(...image.bytes.subarray(start, start + 0x8000));
    return `data:image/${image.kind};base64,${btoa(binary)}`;
  }, [ocr, shownPage]);
  useEffect(() => setShownPage(ocr?.images[0]?.page ?? 1), [ocr]);
  const verified = useMemo(() => new Set(draft.reconciliation.flatMap((item) => item.balanceVerified)), [draft.reconciliation]);
  const highlighted = draft.rows.find((row) => row.id === highlight);
  const pageSize = ocr?.pageSizes.find((size) => size.page === shownPage);

  const revise = (change: DraftChange) => props.onChange(reviseDraft(draft, change, context));
  const plan = useMemo(() => commitPlan(draft, context), [draft, context]);
  const included = draft.rows.filter((row) => decisionFor(draft, row) === "include").length;
  const need = new Set(draft.needs);
  const table = draft.source.kind === "table" ? draft.source : null;
  const currency = draft.effective.currency;

  function blockerText(blocker: CommitBlocker): string {
    switch (blocker.code) {
      case "needs": return u.blockers.needs;
      case "undecided_rows": return t(u.blockers.undecided_rows, { count: blocker.count });
      case "currency_not_storable": return t(u.blockers.currency_not_storable, { currency: blocker.currency });
      case "currency_mismatch_device": return t(u.blockers.currency_mismatch_device, { currency: blocker.currency, device: blocker.device });
      case "nothing_to_import": return u.blockers.nothing_to_import;
    }
  }

  function setMapping(index: number, field: MappedField | "") {
    const next: ColumnMapping = { ...draft.mapping };
    for (const [key, column] of Object.entries(next) as Array<[MappedField, number]>) if (column === index) delete next[key];
    if (field) next[field] = index;
    revise({ mapping: next });
  }

  function startEdit(row: CanonicalTransaction) {
    setEditing(row.id);
    setForm({
      date: row.transactionDate ?? "", description: row.originalDescription,
      amount: row.amountMinor === null ? "" : minorToDecimalString(row.amountMinor, row.currencyExponent),
    });
  }

  function saveEdit(row: CanonicalTransaction) {
    const edit: RowEdit = {};
    if (form.date && form.date !== row.transactionDate) edit.transactionDate = form.date;
    if (form.description.trim() !== row.originalDescription) edit.description = form.description;
    const current = row.amountMinor === null ? "" : minorToDecimalString(row.amountMinor, row.currencyExponent);
    if (form.amount.trim() !== current) edit.amount = form.amount.trim();
    setEditing(null);
    if (Object.keys(edit).length > 0) revise({ edits: { [row.id]: edit }, decisions: { [row.id]: "include" } });
  }

  const select = (label: string, value: string, options: Array<[string, string]>, onSelect: (value: string) => void, needed: boolean, id: string) => (
    <label className={`bw-field ${needed ? "is-needed" : ""}`} htmlFor={id}>
      <span>{label}</span>
      <select id={id} value={value} onChange={(event) => onSelect(event.target.value)} aria-invalid={needed || undefined}>
        {value === "" && <option value="">{u.pick}</option>}
        {options.map(([key, text]) => <option key={key} value={key}>{text}</option>)}
      </select>
    </label>
  );

  const conventions = draft.conventions;
  const setConvention = (change: Partial<Conventions>) => revise({ conventions: change });
  const shown = showAll ? draft.rows : draft.rows.slice(0, ROW_LIMIT);

  return (
    <form className="bw-pdf-review bw-universal" aria-labelledby="universal-title" onSubmit={(event) => {
      event.preventDefault();
      if (plan.ok) props.onConfirm(draft, saveTemplate && table ? { name: templateName } : null);
    }}>
      <section className="bw-panel">
        <span className="bw-eyebrow">{u.eyebrow}</span>
        <h2 id="universal-title">{draft.filename}</h2>
        <p className="bw-muted">
          {t(u.detected, { format: u.formats[draft.format], encoding: draft.detected.encoding?.encoding ?? "UTF-8" })} · {u.privacy}
        </p>
        {draft.templateMatch.status === "matched" && <p className="bw-message bw-message-ok">{t(u.templateMatched, { name: draft.templateMatch.template.name })}</p>}
        {draft.templateMatch.status === "changed" && !draft.mappingConfirmed && (
          <p className="bw-message bw-message-warn" role="alert">
            {t(u.templateChanged, { name: draft.templateMatch.template.name })}{" "}
            <button type="button" className="bw-button bw-button-small" onClick={() => revise({ confirmMapping: true })}>{u.confirmColumns}</button>
          </p>
        )}
      </section>

      {ocr && (
        <section className="bw-panel bw-ocr-original" aria-label={u.ocr.title}>
          <h2>{u.ocr.title}</h2>
          <p className="bw-muted">{t(u.ocr.engine, { engine: `${ocr.engine.id} (${ocr.engine.version})` })}</p>
          {ocr.images.length > 1 && (
            <div className="bw-segmented" role="group" aria-label={u.ocr.title}>
              {ocr.images.map((image) => (
                <button key={image.page} type="button" className={image.page === shownPage ? "is-active" : undefined} aria-pressed={image.page === shownPage} onClick={() => setShownPage(image.page)}>
                  {t(u.ocr.page, { page: image.page })}
                </button>
              ))}
            </div>
          )}
          {pageImage && (
            <div className="bw-ocr-page">
              <img src={pageImage} alt={t(u.ocr.page, { page: shownPage })} />
              {highlighted?.source.box && highlighted.source.page === shownPage && pageSize && (
                <span className="bw-ocr-box" style={{
                  left: `${(highlighted.source.box.x / pageSize.width) * 100}%`, top: `${(highlighted.source.box.y / pageSize.height) * 100}%`,
                  width: `${(highlighted.source.box.width / pageSize.width) * 100}%`, height: `${(highlighted.source.box.height / pageSize.height) * 100}%`,
                  ...(pageSize.rotation ? { outlineStyle: "dashed" } : {}),
                }} />
              )}
            </div>
          )}
          {ocr.missingPages.length > 0 && (
            <p className="bw-message bw-message-warn" role="alert">
              {t(u.ocr.missing, { pages: ocr.missingPages.join(", ") })}{" "}
              {!ocr.missingAcknowledged && <button type="button" className="bw-button bw-button-small" onClick={() => revise({ acknowledgeMissingPages: true })}>{u.ocr.acknowledge}</button>}
            </p>
          )}
        </section>
      )}

      <section className="bw-panel">
        <h2>{u.settings}</h2>
        {draft.needs.length > 0 && <p className="bw-message bw-message-warn" role="status">{u.needsAttention}</p>}
        <div className="bw-universal-settings">
          {table && table.sheetNames.length > 1 && select(u.sheet, String(table.sheetIndex), table.sheetNames.map((name, index) => [String(index), name]), (value) => revise({ sheetIndex: Number(value) }), false, "u-sheet")}
          {table && select(u.headerRow, draft.headerRow === null ? "none" : String(draft.headerRow),
            [["none", u.headerNone], ...table.tables[table.sheetIndex].rows.slice(0, 30).map((_, index) => [String(index), t(u.headerRowN, { row: index + 1 })] as [string, string])],
            (value) => revise({ headerRow: value === "none" ? null : Number(value) }), false, "u-header")}
          {table?.encoding && !table.encoding.confident && select(u.encoding, table.encoding.encoding,
            [table.encoding.encoding, ...table.encoding.alternatives].map((name) => [name, name]), (value) => revise({ encoding: value }), true, "u-encoding")}
          {draft.format !== "ofx" && select(u.dateOrder, conventions.dateOrder ?? (need.has("dateOrder") ? "" : draft.effective.dateOrder ?? ""),
            (["ymd", "dmy", "mdy"] as const).map((order) => [order, u.orders[order]]), (value) => setConvention({ dateOrder: value as Conventions["dateOrder"] }), need.has("dateOrder"), "u-date")}
          {select(u.decimal, conventions.decimal ?? (need.has("decimal") ? "" : draft.effective.decimal),
            [[".", u.decimals.point], [",", u.decimals.comma]], (value) => setConvention({ decimal: value as Conventions["decimal"] }), need.has("decimal"), "u-decimal")}
          {select(u.currency, currency ?? "", [...new Set([...(currency ? [currency] : []), ...CURRENCIES])].map((code) => [code, code]),
            (value) => setConvention({ currency: value }), need.has("currency"), "u-currency")}
          {draft.format !== "ofx" && select(u.accountKind, conventions.accountKind,
            (["unknown", "checking", "savings", "credit_card", "loan"] as const).map((kind) => [kind, u.kinds[kind]]), (value) => setConvention({ accountKind: value as Conventions["accountKind"] }), false, "u-kind")}
          {ocr?.scriptVariants && select(u.ocr.script, conventions.ocrScript ?? "", (["zh-Hans", "zh-Hant"] as const).map((script) => [script, u.ocr.scripts[script]]),
            (value) => setConvention({ ocrScript: value as "zh-Hans" | "zh-Hant" }), need.has("ocrScript"), "u-script")}
          {(need.has("amountSign") || conventions.amountSign) && select(u.amountSign, conventions.amountSign ?? "",
            (["as_is", "invert"] as const).map((sign) => [sign, u.signs[sign]]), (value) => setConvention({ amountSign: value as Conventions["amountSign"] }), need.has("amountSign"), "u-sign")}
        </div>
        {table?.encoding && !table.encoding.confident && <p className="bw-muted">{u.encodingHint}</p>}
        {ocr?.scriptVariants && <p className="bw-muted">{u.ocr.scriptHint}</p>}
      </section>

      {table && (
        <section className={`bw-panel ${need.has("mapping") ? "is-needed" : ""}`}>
          <h2>{u.columns}</h2>
          <p className="bw-muted">{u.columnsHint}</p>
          {draft.mappingProblems.map((problem) => <p key={problem} className="bw-message bw-message-warn">{u.mappingProblems[problem]}</p>)}
          <div className="bw-universal-columns">
            {draft.headers.map((header, index) => {
              const field = (Object.entries(draft.mapping) as Array<[MappedField, number]>).find(([key, column]) => column === index && !(key === "postingDate" && draft.mapping.transactionDate === index))?.[0] ?? "";
              const sample = table.tables[table.sheetIndex].rows[(draft.headerRow ?? -1) + 1]?.[index]?.text ?? "";
              return (
                <label key={index} className="bw-field">
                  <span>{header || `#${index + 1}`} <small className="bw-muted">{sample.slice(0, 24)}</small></span>
                  <select aria-label={`${u.columns} ${header || index + 1}`} value={field} onChange={(event) => setMapping(index, event.target.value as MappedField | "")}>
                    <option value="">{u.fields.ignore}</option>
                    {MAPPED_FIELDS.map((name) => <option key={name} value={name}>{u.fields[name]}</option>)}
                  </select>
                </label>
              );
            })}
          </div>
        </section>
      )}

      <section className="bw-panel">
        <h2>{u.table.decision} <span className="bw-tag">{draft.summary.total}</span></h2>
        <p role="status">{t(u.summary, { total: draft.summary.total, valid: draft.summary.valid, review: draft.summary.needsReview, rejected: draft.summary.rejected, duplicates: draft.summary.duplicates })}</p>
        {draft.reconciliation.map((item, index) => (
          <p key={index} className={item.differenceMinor !== null && item.differenceMinor !== 0 ? "bw-message bw-message-warn" : "bw-muted"}>
            {item.accountKey && `${t(u.account, { account: item.accountKey.split("|").slice(0, 2).filter(Boolean).join(" …") })} · `}
            {item.closing && `${t(u.closing, { amount: money(item.closing.amountMinor, draft.rows[0]?.currencyExponent ?? 2, currency) })} · `}
            {item.differenceMinor === 0 && u.reconciled}
            {item.differenceMinor !== null && item.differenceMinor !== 0 && t(u.difference, { amount: money(item.differenceMinor, draft.rows[0]?.currencyExponent ?? 2, currency) })}
            {item.runningBalanceBreaks.length > 0 && ` ${t(u.breaks, { count: item.runningBalanceBreaks.length })}`}
          </p>
        ))}
        {draft.summary.undecided > 0 && (
          <button type="button" className="bw-button bw-button-outline bw-button-small" onClick={() =>
            revise({ decisions: Object.fromEntries(draft.rows.filter((row) => decisionFor(draft, row) === "undecided").map((row) => [row.id, suggestedDecision(row)])) })}>
            {u.applySuggestions}
          </button>
        )}
        <div className="bw-table-scroll">
          <table className="bw-review-table">
            <thead>
              <tr><th>{u.table.status}</th><th>{u.table.date}</th><th>{u.table.description}</th><th>{u.table.amount}</th><th>{u.table.category}</th><th>{u.table.notes}</th><th>{u.table.decision}</th><th /></tr>
            </thead>
            <tbody>
              {shown.map((row) => {
                const decision = decisionFor(draft, row);
                return (
                  <tr key={row.id} className={row.status === "valid" ? undefined : "is-flagged"} data-row={row.id}>
                    <td><span className={`bw-tag ${row.status === "rejected" ? "bw-tag-muted" : ""}`}>{u.statuses[row.status]}</span></td>
                    {editing === row.id ? (
                      <>
                        <td><input type="date" aria-label={u.table.date} value={form.date} onChange={(event) => setForm({ ...form, date: event.target.value })} /></td>
                        <td><input aria-label={u.table.description} value={form.description} maxLength={500} onChange={(event) => setForm({ ...form, description: event.target.value })} /></td>
                        <td><input aria-label={u.table.amount} inputMode="decimal" title={u.editAmountHint} placeholder="-12.34" value={form.amount} onChange={(event) => setForm({ ...form, amount: event.target.value })} /></td>
                      </>
                    ) : (
                      <>
                        <td>{row.transactionDate ?? "—"}</td>
                        <td>{row.originalDescription || "—"}</td>
                        <td className={`bw-money ${row.amountMinor !== null && row.amountMinor < 0 ? "bw-negative" : "bw-positive"}`}>{money(row.amountMinor, row.currencyExponent, currency)}</td>
                      </>
                    )}
                    <td>
                      {row.status !== "rejected" && row.category !== null ? (
                        <select aria-label={`${u.table.category} ${row.originalDescription}`} value={row.category} onChange={(event) => revise({ edits: { [row.id]: { category: event.target.value } } })}>
                          {props.categories.map((name) => <option key={name} value={name}>{categoryLabel(m, name)}</option>)}
                        </select>
                      ) : "—"}
                    </td>
                    <td>
                      {ocr && row.status !== "rejected" && (
                        <p className="bw-ocr-trust">
                          <span className="bw-tag bw-tag-muted">{t(u.ocr.recognition, { percent: Math.round(Math.min(1, ...Object.values(row.confidence).filter((value): value is number => value !== undefined)) * 100) })}</span>{" "}
                          <span className={`bw-tag ${verified.has(row.id) ? "" : "bw-tag-muted"}`}>{verified.has(row.id) ? u.ocr.proven : u.ocr.unproven}</span>
                        </p>
                      )}
                      <ul className="bw-pdf-warnings">{row.issues.map((item) => <li key={item.code}>{interpolate(u.issues[item.code], item.vars)}</li>)}</ul></td>
                    <td>
                      {row.status === "rejected" ? <span className="bw-muted">{u.statuses.rejected}</span> : (
                        <select aria-label={`${u.table.decision} ${row.originalDescription}`} value={decision === "undecided" ? "" : decision}
                          onChange={(event) => revise({ decisions: { [row.id]: event.target.value as "include" | "skip" } })}>
                          {decision === "undecided" && <option value="">{u.decisions.undecided}</option>}
                          <option value="include">{u.decisions.include}</option>
                          <option value="skip">{u.decisions.skip}</option>
                        </select>
                      )}
                    </td>
                    <td>
                      {editing === row.id ? (
                        <>
                          <button type="button" className="bw-button bw-button-small" onClick={() => saveEdit(row)}>{u.save}</button>
                          <button type="button" className="bw-link-button" onClick={() => setEditing(null)}>{u.cancelEdit}</button>
                        </>
                      ) : <button type="button" className="bw-link-button" onClick={() => startEdit(row)}>{u.edit}</button>}
                      {ocr && row.source.box && (
                        <button type="button" className="bw-link-button" onClick={() => { setHighlight(row.id); if (row.source.page) setShownPage(row.source.page); }}>{u.ocr.showRow}</button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {!showAll && draft.rows.length > ROW_LIMIT && <button type="button" className="bw-link-button" onClick={() => setShowAll(true)}>{t(u.showAll, { count: draft.rows.length })}</button>}
      </section>

      {table && (
        <label className="bw-panel bw-check">
          <input type="checkbox" checked={saveTemplate} onChange={(event) => setSaveTemplate(event.target.checked)} />
          <span>{u.saveTemplate}</span>
          {saveTemplate && <input aria-label={u.templateName} value={templateName} maxLength={80} onChange={(event) => setTemplateName(event.target.value)} />}
        </label>
      )}
      {!plan.ok && <ul className="bw-message bw-message-warn" role="status">{plan.blockers.map((blocker) => <li key={blocker.code}>{blockerText(blocker)}</li>)}</ul>}
      {props.error && <p className="bw-message bw-message-error" role="alert">{props.error}</p>}
      <div className="bw-review-actions">
        <button type="button" className="bw-button bw-button-outline" disabled={props.busy} onClick={props.onCancel}>{u.cancel}</button>
        <button type="submit" className="bw-button bw-button-dark" disabled={props.busy || !plan.ok}>{props.busy ? u.importing : t(u.confirm, { count: included })}</button>
      </div>
    </form>
  );
}
