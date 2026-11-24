// Receipt capture: Scan (camera) or Upload (photo, screenshot, PDF; drag-and-drop on desktop) ->
// read on this device -> the person reviews every field (uncertain and missing ones are marked,
// never presented as fact) -> duplicate guard against the local ledger -> one manual expense or
// refund. Nothing is merged, deleted or edited automatically. "Send to BillieWeather web" is a
// separate, explicit button; nothing leaves the device otherwise.
import { allCategories, formatMoney, type MatchResult, type ReceiptExtraction, type ReceiptIssue } from "@billie/finance-core";
import { CURRENCIES } from "@billie/shared-types";
import { useMemo, useRef, useState, type ReactNode } from "react";
import { DocumentPicker } from "../components/DocumentPicker";
import { PageHeading } from "../components/common";
import { useAccount } from "../hooks/useAccount";
import { useFinance } from "../hooks/useFinance";
import { categoryLabel, interpolate, useI18n } from "../i18n";
import { AccountError } from "../services/account";
import { DocumentTooLarge, receiptExtensions, webDocuments, type LocalDocument } from "../services/documentInput";
import { randomId } from "../services/ids";
import { LedgerError } from "../services/ledger";
import {
  MAX_RECEIPT_BYTES, amountCents, certaintyOf, checkDuplicates, entryFromReceipt, extractReceipt, initialValues, localToday, matchCandidates, ReceiptError, recognizeReceipt, webFields,
  type Certainty, type ReceiptFieldKey, type ReceiptValues, type RecognizedReceipt,
} from "../services/receipt";
import { sendReceipt, type WebReceiptResult } from "../services/receiptUpload";

/** One capture: what was read, kept in memory only until it is saved or discarded. */
interface Capture {
  /** Fixed for this capture: the website's idempotency key for "Send", and the local double-save guard. */
  id: string;
  recognized: RecognizedReceipt;
  extraction: ReceiptExtraction;
  file: { bytes: Uint8Array; filename: string; contentType: string };
}

type Guard = { result: MatchResult; pick: number | string | null };
type Done = { kind: "saved" | "savedRefund" | "kept"; description: string; amount: string };

/** Fields the person must look at before saving when they were not read reliably. */
const KEY_FIELDS: ReceiptFieldKey[] = ["merchant", "date", "total", "currency"];
const PURCHASE_HIDDEN = new Set(["Income", "Transfers"]);

const contentTypeOf = (file: LocalDocument, recognized: RecognizedReceipt) => file.type || (recognized.source === "image" ? "image/jpeg" : "application/pdf");

export function Receipt() {
  const { m } = useI18n();
  const x = m.receipt;
  const { store, refresh, transactions, accounts, customCategories, currency: bookCurrency } = useFinance();
  const { getToken } = useAccount();
  const [capture, setCapture] = useState<Capture | null>(null);
  const [values, setValues] = useState<ReceiptValues | null>(null);
  const [edited, setEdited] = useState<Set<ReceiptFieldKey>>(new Set());
  const [category, setCategory] = useState("Uncategorized");
  const [categorySuggested, setCategorySuggested] = useState(false);
  const [accountId, setAccountId] = useState<number | "">("");
  const [checked, setChecked] = useState(false);
  const [problems, setProblems] = useState<string[]>([]);
  const [guard, setGuard] = useState<Guard | null>(null);
  const [done, setDone] = useState<Done | null>(null);
  const [error, setError] = useState("");
  const [reading, setReading] = useState<AbortController | null>(null);
  const [busy, setBusy] = useState(false);
  const [web, setWeb] = useState<{ tone: "ok" | "error"; text: string; result?: WebReceiptResult } | null>(null);
  const [sending, setSending] = useState(false);
  // Captures already written to the ledger: a second press (double click, retry) never adds a second entry.
  const saved = useRef(new Set<string>());
  const inFlight = useRef(false);

  const liveAccounts = useMemo(() => accounts.filter((account) => !account.archived), [accounts]);
  const categories = useMemo(() => allCategories(customCategories).filter((name) => !PURCHASE_HIDDEN.has(name)), [customCategories]);
  const account = liveAccounts.find((item) => item.id === accountId);
  const book = account?.currency ?? bookCurrency ?? null;

  function reset() {
    setCapture(null); setValues(null); setEdited(new Set()); setChecked(false); setProblems([]); setGuard(null); setDone(null); setError(""); setWeb(null);
  }

  async function onFile(files: LocalDocument[]) {
    const file = files[0];
    if (!file) return;
    reset();
    const controller = new AbortController();
    setReading(controller);
    try {
      const bytes = await file.read(MAX_RECEIPT_BYTES);
      const recognized = await recognizeReceipt(bytes, file.name, controller.signal);
      const extraction = extractReceipt(recognized.lines, { currency: bookCurrency ?? liveAccounts[0]?.currency ?? null, today: localToday() });
      const next = initialValues(extraction);
      setCapture({ id: randomId(), recognized, extraction, file: { bytes, filename: file.name, contentType: contentTypeOf(file, recognized) } });
      setValues(next);
      // Account: the card whose last four digits the receipt shows, else the first real account.
      const byCard = next.cardLast4 ? liveAccounts.find((item) => item.last4 === next.cardLast4) : undefined;
      const byCash = next.paymentMethod === "cash" ? liveAccounts.find((item) => item.type === "cash") : undefined;
      setAccountId((byCard ?? byCash ?? liveAccounts.find((item) => !item.unassigned) ?? liveAccounts[0])?.id ?? "");
      // Category: the existing rule-based categorizer, from the merchant name. Shown as a suggestion.
      if (next.merchant) {
        const categorizer = await store.categorizer();
        const suggestion = categorizer.categorize(next.merchant, -(amountCents(next.total) ?? 1));
        const usable = !PURCHASE_HIDDEN.has(suggestion) && suggestion !== "Uncategorized";
        setCategory(usable ? suggestion : "Uncategorized");
        setCategorySuggested(usable);
      } else {
        setCategory("Uncategorized");
        setCategorySuggested(false);
      }
    } catch (caught) {
      const code = caught instanceof ReceiptError ? caught.code : caught instanceof DocumentTooLarge ? "too_large" : "ocr_failed";
      setError(x.errors[code]);
    } finally {
      setReading(null);
    }
  }

  function change(key: ReceiptFieldKey, value: string) {
    setValues((current) => (current ? { ...current, [key]: value } : current));
    setEdited((current) => new Set(current).add(key));
    setGuard(null);
  }

  const certainty = (key: ReceiptFieldKey): Certainty | "edited" => (edited.has(key) ? "edited" : capture ? certaintyOf(capture.extraction, key) : "missing");
  const needsCheck = KEY_FIELDS.some((key) => { const state = certainty(key); return state === "missing" || state === "uncertain"; });

  function validate(current: ReceiptValues): string[] {
    const found: string[] = [];
    if (!/^\d{4}-\d{2}-\d{2}$/.test(current.date)) found.push(x.required.date);
    if (amountCents(current.total) === null) found.push(x.required.total);
    if (accountId === "") found.push(x.required.account);
    const receiptCurrency = current.currency.trim().toUpperCase();
    if (book && receiptCurrency && receiptCurrency !== book) found.push(interpolate(x.required.currency, { currency: receiptCurrency, book }));
    if (needsCheck && !checked) found.push(x.required.confirm);
    return found;
  }

  const describe = (id: number | string) => {
    const row = transactions.find((item) => item.id === id);
    if (!row) return null;
    return { date: row.bookedOn, description: row.description, amount: formatMoney(row.amountCents, book ?? "USD") };
  };

  /** Confirm: checks the ledger first; only a receipt with no plausible existing entry is saved straight away. */
  async function confirm() {
    if (!capture || !values) return;
    if (saved.current.has(capture.id)) return setError(x.done.already);
    const found = validate(values);
    setProblems(found);
    if (found.length > 0) return;
    const result = checkDuplicates(values, matchCandidates(transactions, accounts, bookCurrency));
    if (result.level === "none") return save();
    setGuard({ result, pick: result.level === "ambiguous" ? null : result.best!.ids[0] });
  }

  async function save() {
    if (!capture || !values || accountId === "") return;
    if (saved.current.has(capture.id)) return setError(x.done.already);
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError("");
    try {
      const input = entryFromReceipt(values, { accountId: Number(accountId), category, words: x.note });
      await store.ledger.createEntry(input);
      saved.current.add(capture.id);
      await refresh();
      setGuard(null);
      setDone({ kind: values.direction === "refund" ? "savedRefund" : "saved", description: input.description ?? category, amount: formatMoney(input.amountCents, account?.currency ?? book ?? "USD") });
    } catch (caught) {
      setError(caught instanceof LedgerError ? (caught.problems.length > 0 ? caught.problems.map((problem) => m.ledger.problems[problem]).join(" ") : m.ledger.errors[caught.code] ?? m.ledger.errors.unknown) : m.ledger.errors.unknown);
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  /** "Keep as the same purchase": nothing is added, nothing in the ledger changes. */
  function keepExisting(id: number | string | null) {
    if (id === null) return setError(x.duplicate.pickFirst);
    const existing = describe(id);
    setGuard(null);
    setDone({ kind: "kept", description: existing?.description ?? "", amount: existing?.amount ?? "" });
  }

  async function send() {
    if (!capture || !values) return;
    const token = getToken();
    if (!token) return setWeb({ tone: "error", text: x.web.signIn });
    setSending(true);
    try {
      const result = await sendReceipt(token, {
        clientRequestId: capture.id, engine: capture.recognized.engine, lines: capture.recognized.lines, fields: webFields(values), file: capture.file,
      });
      const status = (x.web.status as Record<string, string>)[result.receipt.status] ?? x.web.status.unknown;
      setWeb({ tone: "ok", text: interpolate(result.created ? x.web.sent : x.web.already, { status }), result });
    } catch (caught) {
      setWeb({ tone: "error", text: caught instanceof AccountError && caught.code === "offline" ? x.web.offline : x.web.failed });
    } finally {
      setSending(false);
    }
  }

  const certaintyTag = (key: ReceiptFieldKey) => {
    const state = certainty(key);
    return <small id={`receipt-${key}-certainty`} className={`bw-certainty is-${state}`}>{x.certainty[state]}</small>;
  };
  const field = (key: ReceiptFieldKey, input: (props: { id: string; "aria-describedby": string; "data-certainty": string }) => ReactNode, grow = false) => (
    <div className={`bw-field${grow ? " bw-grow" : ""}`} key={key}>
      <label htmlFor={`receipt-${key}`}>{x.fields[key]}</label>
      {input({ id: `receipt-${key}`, "aria-describedby": `receipt-${key}-certainty`, "data-certainty": certainty(key) })}
      {certaintyTag(key)}
    </div>
  );
  const text = (key: ReceiptFieldKey, extra: Record<string, string | number> = {}) => field(key, (props) => (
    <input {...props} {...extra} value={values?.[key] ?? ""} onChange={(e) => change(key, e.target.value)} />
  ));

  const issues = capture?.extraction.issues ?? [];
  const best = guard?.result.best ? describe(guard.result.best.ids[0]) : null;
  const ambiguousIds = guard && guard.result.level === "ambiguous" ? [...new Set(guard.result.proposals.flatMap((proposal) => proposal.ids))] : [];

  const webSection = (
    <div className="bw-receipt-web">
      <button type="button" className="bw-button bw-button-outline" disabled={sending} onClick={() => void send()}>{sending ? x.web.sending : x.web.send}</button>
      <small className="bw-muted">{x.web.explain}</small>
      {web && <p className={`bw-message bw-message-${web.tone}`} role={web.tone === "error" ? "alert" : "status"}>{web.text}</p>}
      {web?.result?.receipt.match?.transaction && (
        <small>{interpolate(x.web.matched, { date: web.result.receipt.match.transaction.booked_on, description: web.result.receipt.match.transaction.description, amount: web.result.receipt.match.transaction.amount })}</small>
      )}
    </div>
  );

  return (
    <>
      <PageHeading eyebrow={x.eyebrow} title={x.title} />
      {!capture && (
        <section className="bw-panel bw-import bw-receipt-capture">
          <p>{x.intro}</p>
          <div className="bw-actions">
            <label className={`bw-button bw-button-dark bw-file-button${reading ? " is-busy" : ""}`}>
              {x.scan}
              <input type="file" accept="image/*" capture="environment" aria-label={x.scan} disabled={Boolean(reading)} onChange={(e) => { void onFile(webDocuments(e.target.files)); e.target.value = ""; }} />
            </label>
          </div>
          <DocumentPicker extensions={receiptExtensions} accept="image/*,.heic,.heif,.pdf,application/pdf"
            label={reading ? x.reading : x.upload} help={x.drop} busy={Boolean(reading)} onChoose={onFile}
            onError={() => setError(x.errors.ocr_failed)} />
          {reading && <button type="button" className="bw-button bw-button-outline bw-button-small" onClick={() => reading.abort()}>{x.stop}</button>}
          <p className="bw-caption">{x.privacy}</p>
        </section>
      )}
      {error && <p className="bw-message bw-message-error" role="alert">{error}</p>}

      {capture && values && done && (
        <section className="bw-panel" aria-live="polite">
          <p className="bw-message bw-message-ok" role="status">{interpolate(x.done[done.kind], { description: done.description, amount: done.amount })}</p>
          <div className="bw-actions"><button type="button" className="bw-button bw-button-outline" onClick={reset}>{x.done.another}</button></div>
          {webSection}
        </section>
      )}

      {capture && values && !done && (
        <form className="bw-panel bw-entry-form bw-receipt-review" aria-label={x.review.title} noValidate onSubmit={(e) => { e.preventDefault(); void confirm(); }}>
          <h2>{x.review.title}</h2>
          <p className="bw-caption">{x.review.intro} {interpolate(x.review.source, { engine: capture.recognized.engine })}</p>
          {issues.length > 0 && (
            <div className="bw-message bw-message-warn" role="status">
              <strong>{x.issuesTitle}</strong>
              <ul>{issues.map((issue: ReceiptIssue) => <li key={issue}>{x.issues[issue]}</li>)}</ul>
            </div>
          )}
          <div className="bw-segmented" role="radiogroup" aria-label={x.fields.direction}>
            {(["purchase", "refund"] as const).map((option) => (
              <button key={option} type="button" role="radio" aria-checked={values.direction === option} className={values.direction === option ? "is-active" : ""}
                onClick={() => { setValues({ ...values, direction: option }); setGuard(null); }}>{x.direction[option]}</button>
            ))}
          </div>
          <div className="bw-form-grid">
            {text("merchant", { maxLength: 60 })}
            {field("date", (props) => <input {...props} type="date" value={values.date} onChange={(e) => change("date", e.target.value)} />)}
            {field("time", (props) => <input {...props} type="time" value={values.time} onChange={(e) => change("time", e.target.value)} />)}
            {text("total", { inputMode: "decimal" })}
            {field("currency", (props) => (
              <select {...props} value={values.currency} onChange={(e) => change("currency", e.target.value)}>
                <option value="">—</option>
                {[...new Set([...(values.currency ? [values.currency] : []), ...CURRENCIES])].map((code) => <option key={code} value={code}>{code}</option>)}
              </select>
            ))}
            {text("tax", { inputMode: "decimal" })}
            {text("tip", { inputMode: "decimal" })}
            {field("paymentMethod", (props) => (
              <select {...props} value={values.paymentMethod} onChange={(e) => change("paymentMethod", e.target.value)}>
                <option value="">{x.payment.none}</option>
                {(["card", "cash", "mobile", "other"] as const).map((method) => <option key={method} value={method}>{x.payment[method]}</option>)}
              </select>
            ))}
            {text("cardLast4", { inputMode: "numeric", maxLength: 4 })}
            {text("receiptNumber", { maxLength: 40 })}
            <div className="bw-field">
              <label htmlFor="receipt-category">{x.fields.category}</label>
              <select id="receipt-category" value={category} onChange={(e) => { setCategory(e.target.value); setCategorySuggested(false); }}>
                {categories.map((name) => <option key={name} value={name}>{categoryLabel(m, name)}</option>)}
              </select>
              {categorySuggested && <small className="bw-certainty is-uncertain">{x.categorySuggested}</small>}
            </div>
            <div className="bw-field">
              <label htmlFor="receipt-account">{x.fields.account}</label>
              <select id="receipt-account" value={accountId} onChange={(e) => { setAccountId(e.target.value === "" ? "" : Number(e.target.value)); setGuard(null); }}>
                <option value="">—</option>
                {liveAccounts.map((item) => <option key={item.id} value={item.id}>{item.unassigned ? m.ledger.accounts.unassigned : item.name}</option>)}
              </select>
              {liveAccounts.length === 0 && <small className="bw-field-error">{x.noAccounts}</small>}
            </div>
          </div>
          <section aria-label={x.lineItems}>
            <h3>{x.lineItems}</h3>
            {capture.extraction.lineItems.length === 0 ? <p className="bw-muted">{x.noLineItems}</p> : (
              <ul className="bw-simple-list bw-receipt-items">
                {capture.extraction.lineItems.map((item) => (
                  <li key={item.line}><span>{item.quantity ? `${item.quantity} × ` : ""}{item.description}</span> <strong>{item.amount ?? ""}</strong></li>
                ))}
              </ul>
            )}
          </section>
          {needsCheck && (
            <label className="bw-check"><input type="checkbox" checked={checked} onChange={(e) => setChecked(e.target.checked)} /> {x.confirmUncertain}</label>
          )}
          {problems.length > 0 && <div className="bw-message bw-message-error" role="alert">{problems.map((problem) => <p key={problem}>{problem}</p>)}</div>}

          {guard && (guard.result.level === "exact" || guard.result.level === "probable") && best && (
            <div className="bw-message bw-message-warn" role="alertdialog" aria-label={x.duplicate.title}>
              <strong>{x.duplicate.title}</strong>
              <p>{interpolate(x.duplicate.same, best)}</p>
              <div className="bw-actions">
                <button type="button" className="bw-button bw-button-dark" disabled={busy} onClick={() => keepExisting(guard.result.best!.ids[0])}>{x.duplicate.keep}</button>
                <button type="button" className="bw-button bw-button-outline" disabled={busy} onClick={() => void save()}>{x.duplicate.different}</button>
              </div>
            </div>
          )}
          {guard && guard.result.level === "ambiguous" && (
            <div className="bw-message bw-message-warn" role="alertdialog" aria-label={x.duplicate.ambiguousTitle}>
              <strong>{x.duplicate.ambiguousTitle}</strong>
              <p>{x.duplicate.ambiguous}</p>
              <div role="radiogroup" aria-label={x.duplicate.ambiguousTitle}>
                {ambiguousIds.map((id) => {
                  const row = describe(id);
                  return row && (
                    <label key={String(id)} className="bw-check">
                      <input type="radio" name="receipt-candidate" checked={guard.pick === id} onChange={() => setGuard({ ...guard, pick: id })} />
                      {interpolate(x.duplicate.candidate, row)}
                    </label>
                  );
                })}
              </div>
              <div className="bw-actions">
                <button type="button" className="bw-button bw-button-dark" disabled={busy || guard.pick === null} onClick={() => keepExisting(guard.pick)}>{x.duplicate.pick}</button>
                <button type="button" className="bw-button bw-button-outline" disabled={busy} onClick={() => void save()}>{x.duplicate.none}</button>
              </div>
            </div>
          )}

          <div className="bw-actions">
            {!guard && <button type="submit" className="bw-button bw-button-dark" disabled={busy}>{busy ? x.saving : x.save}</button>}
            <button type="button" className="bw-button bw-button-outline" disabled={busy} onClick={reset}>{x.discard}</button>
          </div>
          {webSection}
        </form>
      )}
    </>
  );
}
