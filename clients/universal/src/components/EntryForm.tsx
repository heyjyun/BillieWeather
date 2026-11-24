// Create or edit one manual entry (记一笔): expense, income, transfer / card payment, refund or a
// balance adjustment. The same form edits imported rows (category, description, merchant, project,
// tags, note); their amount and date stay as the bank printed them.
import { decimalToCents, centsToDecimalString, formatMoney, isLiability, localToday, type EntryProblem, type TransactionKind } from "@billie/finance-core";
import { useEffect, useMemo, useState, type FormEvent } from "react";
import { useFinance } from "../hooks/useFinance";
import { categoryLabel, useI18n } from "../i18n";
import { LedgerError, type CategoryNode, type EntryDetail, type EntryInput } from "../services/ledger";
import type { QuickEntry } from "../services/quickEntry";
import { useDraftState, useMode } from "../hooks/useMode";

const KINDS: TransactionKind[] = ["expense", "income", "transfer", "refund", "adjustment"];

/** "12.34" / "12,34" / "-5" -> cents; null when not a plain amount. */
export function parseAmount(text: string, allowNegative = false): number | null {
  const clean = text.replace(/\s/g, "").replace(/^\+/, "");
  const normalized = /^-?\d+,\d{1,2}$/.test(clean) ? clean.replace(",", ".") : clean.replace(/,(?=\d{3}(\D|$))/g, "");
  if (!/^-?\d+(\.\d{1,2})?$/.test(normalized)) return null;
  if (!allowNegative && normalized.startsWith("-")) return null;
  try {
    return decimalToCents(normalized);
  } catch {
    return null;
  }
}

type EntryFormProps = { entry?: EntryDetail | null; initialKind?: TransactionKind; prefill?: QuickEntry; draftId?: string; onDone: (message: string) => void; onCancel: () => void };

/**
 * The fields are a draft (useDraftState), so switching to Default Mode and back keeps what was typed.
 * Saving or cancelling discards the draft; a restored draft can also be discarded explicitly.
 */
export function EntryForm(props: EntryFormProps) {
  const { m } = useI18n();
  const { hasDraft, clearDraft } = useMode();
  const draftKey = `entry-${props.entry?.id ?? props.draftId ?? "new"}`;
  const [generation, setGeneration] = useState(0);
  const [restored, setRestored] = useState(() => hasDraft(draftKey));
  const finish = (done: () => void) => { clearDraft(draftKey); done(); };
  return (
    <>
      {restored && (
        <p className="bw-message bw-draft-note" role="status">
          {m.ledger.mode.draftRestored}{" "}
          <button type="button" className="bw-link-button" onClick={() => { clearDraft(draftKey); setRestored(false); setGeneration((g) => g + 1); }}>{m.ledger.mode.draftDiscard}</button>
        </p>
      )}
      <EntryFormFields key={generation} {...props} draftKey={draftKey} onDone={(message) => finish(() => props.onDone(message))} onCancel={() => finish(props.onCancel)} />
    </>
  );
}

function EntryFormFields({ entry, initialKind = "expense", prefill, onDone, onCancel, draftKey }: EntryFormProps & { draftKey: string }) {
  const { m, t } = useI18n();
  const x = m.ledger.entry;
  const { store, accounts, customCategories, currency, refresh } = useFinance();
  const editing = Boolean(entry);
  const imported = Boolean(entry && entry.origin !== "manual" && entry.origin !== "recurring");
  const live = accounts.filter((account) => !account.archived || account.id === entry?.accountId || account.id === entry?.counterpart?.accountId);
  const startKind: TransactionKind = entry ? (entry.kind === "card_payment" ? "transfer" : entry.kind) : initialKind;
  const transferFrom = entry && (entry.kind === "transfer" || entry.kind === "card_payment") && entry.amountCents > 0 && entry.counterpart ? entry.counterpart.accountId : entry?.accountId;
  const transferTo = entry && (entry.kind === "transfer" || entry.kind === "card_payment") ? (entry.amountCents > 0 ? entry.accountId : entry.counterpart?.accountId) : undefined;

  const [kind, setKind] = useDraftState<TransactionKind>(draftKey, "kind", startKind);
  const [amount, setAmount] = useDraftState(draftKey, "amount", entry ? centsToDecimalString(startKind === "adjustment" ? entry.amountCents : Math.abs(entry.amountCents)).replace(/\.(\d)$/, ".$10") : prefill?.amount ?? "");
  const [date, setDate] = useDraftState(draftKey, "date", entry?.occurredOn ?? localToday());
  const [time, setTime] = useDraftState(draftKey, "time", entry?.time ?? "");
  const [accountId, setAccountId] = useDraftState<number | "">(draftKey, "accountId", transferFrom ?? live.find((account) => !account.unassigned)?.id ?? "");
  const [toAccountId, setToAccountId] = useDraftState<number | "">(draftKey, "toAccountId", transferTo ?? "");
  const [category, setCategory] = useDraftState(draftKey, "category", entry?.category ?? "");
  const [merchant, setMerchant] = useDraftState(draftKey, "merchant", entry?.merchant ?? "");
  const [project, setProject] = useDraftState(draftKey, "project", entry?.project ?? "");
  const [tags, setTags] = useDraftState(draftKey, "tags", entry?.tags.join(", ") ?? "");
  const [note, setNote] = useDraftState(draftKey, "note", entry?.note ?? "");
  const [description, setDescription] = useDraftState(draftKey, "description", entry?.description ?? prefill?.description ?? "");
  const [refundOf, setRefundOf] = useDraftState<number | "">(draftKey, "refundOf", entry?.refundOf?.id ?? "");
  const [tree, setTree] = useState<CategoryNode[]>([]);
  const [candidates, setCandidates] = useState<Awaited<ReturnType<typeof store.ledger.refundCandidates>>>([]);
  const [merchants, setMerchants] = useState<string[]>([]);
  const [projects, setProjects] = useState<string[]>([]);
  const [problems, setProblems] = useState<EntryProblem[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const cur = currency ?? accounts[0]?.currency ?? "USD";

  useEffect(() => {
    void store.ledger.categoryTree(customCategories).then(setTree);
    void store.ledger.dimensions("merchant").then((items) => setMerchants(items.map((item) => item.name)));
    void store.ledger.dimensions("project").then((items) => setProjects(items.map((item) => item.name)));
  }, [store, customCategories]);
  useEffect(() => {
    if (kind === "refund") void store.ledger.refundCandidates({ limit: 200 }).then((items) => setCandidates(entry?.refundOf && !items.some((item) => item.id === entry.refundOf!.id)
      ? [{ id: entry.refundOf.id, occurredOn: "", description: entry.refundOf.description, amountCents: entry.refundOf.amountCents, refundableCents: Math.abs(entry.refundOf.amountCents), accountName: "", category: entry.category }, ...items] : items));
  }, [kind, store, entry]);

  // Categories offered for this kind: the matching tree, hidden ones left out (unless already chosen).
  const options = useMemo(() => {
    const wanted = kind === "income" ? "income" : "expense";
    const out: Array<{ name: string; label: string }> = [];
    for (const node of tree) {
      if (node.kind === "transfer") continue;
      const fits = node.kind === wanted || node.kind === "any";
      if (fits && (!node.hidden || node.name === category)) out.push({ name: node.name, label: categoryLabel(m, node.name) });
      for (const child of node.children) if ((child.kind === wanted) && (!child.hidden || child.name === category)) out.push({ name: child.name, label: `${categoryLabel(m, node.name)} › ${child.name}` });
    }
    return out;
  }, [tree, kind, category, m]);
  const needsCategory = kind === "expense" || kind === "income" || kind === "refund";
  const isTransfer = kind === "transfer" || kind === "card_payment";
  const toAccount = live.find((account) => account.id === toAccountId);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError("");
    const cents = parseAmount(amount, kind === "adjustment");
    if (accountId === "") return setProblems(["account_required"]);
    const input: EntryInput = {
      kind: isTransfer && toAccount && isLiability(toAccount.type) ? "card_payment" : kind, amountCents: cents ?? Number.NaN, occurredOn: date, time: time || null,
      accountId: Number(accountId), toAccountId: isTransfer && toAccountId !== "" ? Number(toAccountId) : null,
      category: needsCategory ? category || (kind === "income" ? "Income" : "Uncategorized") : null, description: description.trim() || null, note: note.trim() || null,
      merchant: merchant.trim() || null, project: project.trim() || null, tags: tags.split(/[,，、]/).map((tag) => tag.trim()).filter(Boolean),
      refundOf: kind === "refund" ? (refundOf === "" ? (editing ? undefined : null) : Number(refundOf)) : undefined,
    };
    if (input.kind === "card_payment") input.kind = "transfer";
    const found = await store.ledger.validate(input, entry?.id);
    const relevant = imported ? found.filter((problem) => !["amount_required", "amount_zero", "amount_precision", "date_invalid"].includes(problem)) : found;
    setProblems(relevant);
    if (relevant.length > 0) return;
    setBusy(true);
    try {
      if (entry) {
        await store.ledger.updateEntry(entry.id, imported ? { ...input, amountCents: Math.abs(entry.amountCents), occurredOn: entry.occurredOn } : input);
        await refresh();
        onDone(x.updated);
      } else {
        await store.ledger.createEntry(input);
        await refresh();
        onDone(x.created);
      }
    } catch (caught) {
      if (caught instanceof LedgerError) {
        setProblems(caught.problems);
        setError(m.ledger.errors[caught.code] ?? m.ledger.errors.unknown);
      } else setError(m.ledger.errors.unknown);
    } finally {
      setBusy(false);
    }
  }

  const problem = (key: EntryProblem) => (problems.includes(key) ? <small className="bw-field-error" role="alert">{m.ledger.problems[key]}</small> : null);
  return (
    <form className="bw-panel bw-entry-form" aria-label={editing ? x.editTitle : x.newTitle} onSubmit={submit} noValidate>
      <h2>{editing ? x.editTitle : x.newTitle}</h2>
      {!imported && (
        <div className="bw-segmented" role="radiogroup" aria-label={x.type}>
          {KINDS.map((option) => (
            <button key={option} type="button" role="radio" aria-checked={kind === option} className={kind === option ? "is-active" : ""} onClick={() => { setKind(option); setProblems([]); }}>
              {m.ledger.kinds[option]}
            </button>
          ))}
        </div>
      )}
      {imported && <p className="bw-caption">{x.importedNote} {entry && entry.originalDescription !== entry.description && t("ledger.entry.original", { text: entry.originalDescription })}</p>}
      <div className="bw-form-grid">
        {!imported && (
          <label className="bw-field">
            <span>{x.amount}</span>
            <input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} aria-invalid={problems.some((p) => p.startsWith("amount"))} required />
            {problem("amount_required")}{problem("amount_zero")}{problem("amount_precision")}{problem("amount_too_large")}
            {kind === "adjustment" && <small>{x.adjustmentHelp}</small>}
          </label>
        )}
        {!imported && (
          <label className="bw-field"><span>{x.date}</span><input type="date" value={date} onChange={(e) => setDate(e.target.value)} required />{problem("date_invalid")}</label>
        )}
        <label className="bw-field"><span>{x.time} <small>({m.ledger.common.optional})</small></span><input type="time" value={time} onChange={(e) => setTime(e.target.value)} /></label>
        <label className="bw-field">
          <span>{isTransfer ? x.from : x.account}</span>
          <select value={accountId} onChange={(e) => setAccountId(e.target.value === "" ? "" : Number(e.target.value))} disabled={imported && isTransfer}>
            <option value="">—</option>
            {live.map((account) => <option key={account.id} value={account.id}>{account.unassigned ? m.ledger.accounts.unassigned : account.name}</option>)}
          </select>
          {problem("account_required")}
        </label>
        {isTransfer && (
          <label className="bw-field">
            <span>{x.to}</span>
            <select value={toAccountId} onChange={(e) => setToAccountId(e.target.value === "" ? "" : Number(e.target.value))} disabled={imported}>
              <option value="">—</option>
              {live.filter((account) => account.id !== accountId && !account.unassigned).map((account) => <option key={account.id} value={account.id}>{account.name}</option>)}
            </select>
            {problem("accounts_same")}
            {toAccount && isLiability(toAccount.type) && <small>{m.ledger.kinds.card_payment}</small>}
          </label>
        )}
        {needsCategory && (
          <label className="bw-field">
            <span>{x.category}</span>
            <select value={category} onChange={(e) => setCategory(e.target.value)}>
              <option value="">{kind === "income" ? categoryLabel(m, "Income") : categoryLabel(m, "Uncategorized")}</option>
              {options.map((option) => <option key={option.name} value={option.name}>{option.label}</option>)}
            </select>
            {problem("category_kind")}
          </label>
        )}
        {kind === "refund" && (
          <label className="bw-field bw-grow">
            <span>{x.refundOf}</span>
            <select value={refundOf} onChange={(e) => setRefundOf(e.target.value === "" ? "" : Number(e.target.value))}>
              <option value="">{x.refundPick}</option>
              {candidates.map((item) => (
                <option key={item.id} value={item.id}>{`${item.occurredOn} · ${item.description} · ${formatMoney(item.amountCents, cur)} · ${t("ledger.entry.refundable", { amount: formatMoney(item.refundableCents, cur) })}`}</option>
              ))}
            </select>
            {problem("refund_target_required")}{problem("refund_too_large")}
          </label>
        )}
        <label className="bw-field">
          <span>{x.merchant} <small>({m.ledger.common.optional})</small></span>
          <input list="bw-merchants" value={merchant} onChange={(e) => setMerchant(e.target.value)} maxLength={60} />
          <datalist id="bw-merchants">{merchants.map((name) => <option key={name} value={name} />)}</datalist>
        </label>
        <label className="bw-field">
          <span>{x.project} <small>({m.ledger.common.optional})</small></span>
          <input list="bw-projects" value={project} onChange={(e) => setProject(e.target.value)} maxLength={60} />
          <datalist id="bw-projects">{projects.map((name) => <option key={name} value={name} />)}</datalist>
        </label>
        <label className="bw-field"><span>{x.tags} <small>({m.ledger.common.optional})</small></span><input value={tags} onChange={(e) => setTags(e.target.value)} /><small>{x.tagsHelp}</small></label>
        <label className="bw-field bw-grow"><span>{x.description} <small>({m.ledger.common.optional})</small></span><input value={description} onChange={(e) => setDescription(e.target.value)} maxLength={500} /></label>
        <label className="bw-field bw-grow"><span>{x.note} <small>({m.ledger.common.optional})</small></span><textarea value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} rows={2} /></label>
      </div>
      {error && <p className="bw-message bw-message-error" role="alert">{error}</p>}
      <div className="bw-actions">
        <button type="submit" className="bw-button bw-button-dark" disabled={busy}>{busy ? m.ledger.common.saving : m.ledger.common.save}</button>
        <button type="button" className="bw-button bw-button-outline" onClick={onCancel}>{m.ledger.common.cancel}</button>
      </div>
    </form>
  );
}
