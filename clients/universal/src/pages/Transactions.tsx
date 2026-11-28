import type { Category, Transaction, TransactionKind } from "@billie/shared-types";
import { allCategories, isCounted, kindOf, formatMoney, merchantKey, subtreeMatcher } from "@billie/finance-core";
import { formatRange } from "@nlae/core";
import { currencyLookup } from "../overview/local";
import { matchTransactions, type TransactionFilter } from "../commands/handlers";
import { useEffect, useMemo, useState } from "react";
import { categoryChoices, CategorySelect, ConfirmDelete, Empty, indented, Money, PageHeading } from "../components/common";
import { EntryForm } from "../components/EntryForm";
import { OrganizePanel } from "../components/OrganizePanel";
import { useFinance } from "../hooks/useFinance";
import { categoryLabel, useI18n } from "../i18n";
import { LedgerError, type EntryDetail } from "../services/ledger";
import { useDraftState, useMode } from "../hooks/useMode";
import { randomId } from "../services/ids";
import type { TransactionIntent } from "../App";

/** Rows added to the page at a time: every row has its own category menu, so thousands at once are slow to open. */
const PAGE_ROWS = 200;

type View = "list" | "trash" | "review" | "organize";
const KIND_FILTERS: TransactionKind[] = ["expense", "income", "refund", "transfer", "card_payment", "adjustment"];

/**
 * `preset`: a filter from a typed command; it stays until the person changes the filters or clears it.
 * `intent`: open a new entry of a kind, or the trash / review list (from the Manual home).
 * The entry form, trash, review list, extra filters, batch edit and row edit/copy/delete are part of
 * Manual Mode; Default Mode keeps the simple list (search, category, include/exclude).
 */
export function Transactions({ preset, intent }: { preset?: TransactionFilter; intent?: TransactionIntent } = {}) {
  const { m, t } = useI18n();
  const { manual } = useMode();
  const [toolsExpanded, setToolsExpanded] = useState(false);
  const manualTools = manual || toolsExpanded;
  const { transactions, customCategories, categoryTree, currency, store, refresh, accounts, statements } = useFinance();
  const categories = useMemo(() => allCategories(customCategories), [customCategories]);
  const [query, setQuery] = useState(preset?.query ?? "");
  const [filter, setFilter] = useState<Category | "all">(preset?.category ?? "all");
  const [kind, setKind] = useState<TransactionKind | "all">("all");
  const [accountFilter, setAccountFilter] = useState<number | "all">(preset?.accountId ?? "all");
  const [dimension, setDimension] = useState("");
  const [commandFilter, setCommandFilter] = useState<TransactionFilter | null>(preset && (preset.period || preset.amount || preset.query) ? preset : null);
  const [remember, setRemember] = useState(true);
  // Successes go to the polite status line; failures are shown as an error and announced as an alert.
  const [status, setStatusState] = useState<{ text: string; error: boolean }>({ text: "", error: false });
  const setStatus = (text: string) => setStatusState({ text, error: false });
  const setError = (text: string) => setStatusState({ text, error: true });
  // The open entry form is part of the draft, so it is still open (and filled in) after a mode switch.
  const [form, setForm] = useDraftState<{ entry: EntryDetail | null; kind?: TransactionKind; prefill?: TransactionIntent["entryDraft"]; draftId?: string } | null>("transactions-page", "form", null);
  const [requestedView, setView] = useState<View>(intent?.view ?? "list");
  const view: View = requestedView;
  useEffect(() => { if (intent?.entryKind) setForm({ entry: null, kind: intent.entryKind, prefill: intent.entryDraft, draftId: intent.entryDraft ? randomId() : undefined }); }, [intent, setForm]);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [batchCategory, setBatchCategory] = useState("");
  const [batchText, setBatchText] = useState({ merchant: "", project: "", tag: "" });
  const [trash, setTrash] = useState<EntryDetail[]>([]);
  // Deleting for good is confirmed in the page: entries (one row) or the whole trash.
  const [purging, setPurging] = useState<EntryDetail | "all" | null>(null);
  const [suspects, setSuspects] = useState<Awaited<ReturnType<typeof store.ledger.suspectIncome>>>([]);
  const codeFor = useMemo(() => currencyLookup(accounts, statements, currency ?? "USD"), [accounts, statements, currency]);
  const cur = currency ?? accounts[0]?.currency ?? "USD";
  const x = m.transactions;
  const L = m.ledger.list;
  const accountName = useMemo(() => new Map(accounts.map((a) => [a.id, a.unassigned ? m.ledger.accounts.unassigned : a.name])), [accounts, m]);

  useEffect(() => { void store.ledger.suspectIncome().then(setSuspects); }, [store, transactions]);
  useEffect(() => { if (view === "trash") void store.ledger.trash().then(setTrash); }, [view, store, transactions]);

  const visible = useMemo(() => {
    // A command's filter uses the same matching as the command's own count.
    const base = commandFilter ? matchTransactions(transactions, { ...commandFilter, category: filter === "all" ? undefined : filter }, categoryTree) : transactions;
    // A category filter means the category and everything below it.
    const inFilter = filter === "all" ? null : subtreeMatcher(categoryTree, filter);
    const q = query.trim().toLowerCase();
    const d = dimension.trim().toLowerCase();
    return base.filter((transaction) => (commandFilter || inFilter === null || inFilter(transaction.category))
      && (commandFilter || !q || transaction.description.toLowerCase().includes(q) || (transaction.originalDescription ?? "").toLowerCase().includes(q) || (transaction.note ?? "").toLowerCase().includes(q))
      && (!manualTools || kind === "all" || transaction.kind === kind)
      && (accountFilter === "all" || transaction.accountId === accountFilter)
      && (!commandFilter?.activity || (isCounted(transaction) && (commandFilter.activity === "counted" ||
        (kindOf(transaction) === "income") === (commandFilter.activity === "income"))))
      && (!commandFilter?.currency || codeFor(transaction) === commandFilter.currency)
      && (!manualTools || !d || [transaction.merchant, transaction.project, ...(transaction.tags ?? [])].some((value) => (value ?? "").toLowerCase().includes(d))));
  }, [transactions, query, filter, commandFilter, kind, accountFilter, dimension, manualTools, codeFor]);
  // Back to the first rows whenever the filters change (not after editing a row).
  const filterKey = JSON.stringify([query, filter, kind, accountFilter, dimension, commandFilter, manualTools]);
  const [shown, setShown] = useState({ key: filterKey, rows: PAGE_ROWS });
  const rowLimit = shown.key === filterKey ? shown.rows : PAGE_ROWS;
  const hidden = visible.length - rowLimit;
  const commandSummary = commandFilter && [
    commandFilter.currency,
    commandFilter.accountId ? accountName.get(commandFilter.accountId) : null,
    commandFilter.activity === "income" ? m.dashboard.income : commandFilter.activity === "spending" ? m.dashboard.spending : null,
    commandFilter.query ? `“${commandFilter.query}”` : null,
    commandFilter.period ? formatRange(commandFilter.period) : null,
    commandFilter.amount ? `${{ eq: "=", gt: ">", gte: "≥", lt: "<", lte: "≤" }[commandFilter.amount.comparator]} ${formatMoney(commandFilter.amount.amountMinor, commandFilter.amount.currency ?? cur)}` : null,
  ].filter(Boolean).join(" · ");

  async function run(action: () => Promise<unknown>, message: string) {
    try {
      await action();
      await refresh();
      setStatus(message);
    } catch (caught) {
      setError(caught instanceof LedgerError ? m.ledger.errors[caught.code] ?? m.ledger.errors.unknown : m.ledger.errors.unknown);
    }
  }

  async function change(transaction: Transaction, category: Category) {
    let others: number;
    try {
      others = await store.setCategory(transaction.id, category, remember);
    } catch {
      return setError(m.ledger.errors.unknown);
    }
    await refresh();
    const merchant = merchantKey(transaction.description);
    if (remember && merchant && category !== "Uncategorized") {
      const vars = { merchant, category: categoryLabel(m, category), count: others };
      setStatus(others ? t("transactions.savedRuleOthers", vars) : t("transactions.savedRule", vars));
    } else {
      setStatus(x.saved);
    }
  }

  async function toggleExcluded(transaction: Transaction) {
    await run(() => store.setExcluded(transaction.id, !transaction.excluded), transaction.excluded ? x.included : x.excludedStatus);
  }

  useEffect(() => { if (view !== "trash") setPurging(null); }, [view]);
  const toggle = (id: number) => setSelected((was) => { const next = new Set(was); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  const ids = [...selected];

  const heading = (
    <PageHeading eyebrow={x.eyebrow} title={x.title}>
      <div className="bw-actions">
        {!manual && <button type="button" className="bw-button bw-button-outline" aria-expanded={toolsExpanded} onClick={() => setToolsExpanded(!toolsExpanded)}>{m.ledger.manual.title}</button>}
        {manualTools && <button type="button" className="bw-button bw-button-dark" onClick={() => { setView("list"); setForm({ entry: null }); }}>{m.ledger.entry.add}</button>}
        <button type="button" className="bw-button bw-button-outline" aria-pressed={view === "organize"} onClick={() => setView(view === "organize" ? "list" : "organize")}>{m.ledger.organize.button}</button>
        {manualTools && suspects.length > 0 && <button type="button" className="bw-button bw-button-outline" aria-pressed={view === "review"} onClick={() => setView(view === "review" ? "list" : "review")}>{L.review} ({suspects.length})</button>}
        {manualTools && <button type="button" className="bw-button bw-button-outline" aria-pressed={view === "trash"} onClick={() => setView(view === "trash" ? "list" : "trash")}>{L.trash}</button>}
      </div>
    </PageHeading>
  );
  const statusLine = (
    <>
      <p className="bw-sr-status" role="status" aria-live="polite">{status.error ? "" : status.text}</p>
      {status.error && <p className="bw-message bw-message-error" role="alert">{status.text}</p>}
    </>
  );
  const formPanel = form && (
    <EntryForm key={form.draftId ?? form.entry?.id ?? "new"} entry={form.entry} initialKind={form.kind} prefill={form.prefill} draftId={form.draftId} onCancel={() => setForm(null)} onDone={(message) => { setForm(null); setStatus(message); }} />
  );

  if (view === "organize") return <>{heading}{statusLine}<OrganizePanel onClose={() => setView("list")} /></>;

  if (view === "trash") {
    return (
      <>
        {heading}{statusLine}
        <section className="bw-panel" aria-labelledby="trash-heading">
          <h2 id="trash-heading">{L.trashTitle}</h2>
          <p className="bw-caption">{L.trashIntro}</p>
          {trash.length === 0 ? <p>{L.trashEmpty}</p> : (
            <>
              {purging && (
                <ConfirmDelete key={purging === "all" ? "all" : purging.id} action={purging === "all" ? L.emptyTrash : L.purge} onCancel={() => setPurging(null)}
                  question={purging === "all" ? t("ledger.list.emptyConfirm", { count: trash.length }) : t("ledger.list.purgeConfirm", { description: purging.description })}
                  onConfirm={() => {
                    const target = purging;
                    setPurging(null);
                    if (target === "all") void run(() => store.ledger.emptyTrash(), t("ledger.list.purged", { count: trash.length }));
                    else void run(() => store.ledger.purgeEntries([target.id]), t("ledger.list.purged", { count: 1 }));
                  }} />
              )}
              <ul className="bw-tx-table">
                {trash.map((entry) => (
                  <li key={entry.id}>
                    <div className="bw-tx-main"><strong>{entry.description}</strong><small>{entry.occurredOn} · {entry.accountName} · {m.ledger.kinds[entry.kind]}</small></div>
                    <Money cents={entry.amountCents} currency={cur} signed />
                    <div className="bw-row-actions">
                      <button type="button" className="bw-link-button" onClick={() => run(() => store.ledger.restoreEntries([entry.id]), L.restored)}>{L.restore}</button>
                      <button type="button" className="bw-link-button bw-danger" onClick={() => setPurging(entry)}>{L.purge}</button>
                    </div>
                  </li>
                ))}
              </ul>
              <button type="button" className="bw-button bw-button-danger" onClick={() => setPurging("all")}>{L.emptyTrash}</button>
            </>
          )}
          <button type="button" className="bw-link-button" onClick={() => setView("list")}>{L.backToList}</button>
        </section>
      </>
    );
  }

  if (view === "review") {
    return (
      <>
        {heading}{statusLine}
        <section className="bw-panel" aria-labelledby="review-heading">
          <h2 id="review-heading">{L.reviewTitle}</h2>
          <p className="bw-caption">{L.reviewIntro}</p>
          <ul className="bw-tx-table">
            {suspects.map((row) => (
              <li key={row.id}>
                <div className="bw-tx-main"><strong>{row.description}</strong><small>{row.occurredOn} · {row.accountName}</small></div>
                <Money cents={row.amountCents} currency={cur} signed />
                <div className="bw-row-actions">
                  <button type="button" className="bw-button bw-button-small" onClick={() => run(() => store.ledger.setKind(row.id, row.suggested), m.ledger.common.saved)}>{t("ledger.list.markAs", { kind: m.ledger.kinds[row.suggested] })}</button>
                  <button type="button" className="bw-link-button" onClick={() => run(() => store.ledger.setKind(row.id, "income"), m.ledger.common.saved)}>{L.keepIncome}</button>
                </div>
              </li>
            ))}
          </ul>
          <button type="button" className="bw-link-button" onClick={() => setView("list")}>{L.backToList}</button>
        </section>
      </>
    );
  }

  if (transactions.length === 0) return <>{heading}{statusLine}{formPanel}<Empty title={x.emptyTitle} body={x.emptyBody} /></>;

  return (
    <>
      {heading}
      {formPanel}
      <div className="bw-filter-bar">
        <label className="bw-field bw-grow"><span>{x.search}</span><input type="search" value={query} onChange={(e) => { setCommandFilter(null); setQuery(e.target.value); }} placeholder={x.searchPlaceholder} /></label>
        <label className="bw-field"><span>{x.category}</span>
          <select value={filter} onChange={(e) => setFilter(e.target.value as Category | "all")}>
            <option value="all">{x.allCategories}</option>
            {categoryChoices(categoryTree, categories, filter === "all" ? null : filter).map((c) => <option key={c.name} value={c.name}>{indented(categoryLabel(m, c.name), c.depth)}</option>)}
          </select>
        </label>
        {manualTools && <>
        <label className="bw-field"><span>{L.kind}</span>
          <select value={kind} onChange={(e) => setKind(e.target.value as TransactionKind | "all")}>
            <option value="all">{L.allKinds}</option>
            {KIND_FILTERS.map((k) => <option key={k} value={k}>{m.ledger.kinds[k]}</option>)}
          </select>
        </label>
        <label className="bw-field"><span>{L.account}</span>
          <select value={accountFilter} onChange={(e) => setAccountFilter(e.target.value === "all" ? "all" : Number(e.target.value))}>
            <option value="all">{L.allAccounts}</option>
            {accounts.map((a) => <option key={a.id} value={a.id}>{accountName.get(a.id)}</option>)}
          </select>
        </label>
        <label className="bw-field"><span>{L.merchant} / {L.project} / {L.tag}</span><input value={dimension} onChange={(e) => setDimension(e.target.value)} /></label>
        </>}
        <label className="bw-check"><input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} /> {x.remember}</label>
      </div>
      {commandSummary && (
        <p className="bw-command-filter">
          <span>{t("command.filter.active", { filter: commandSummary })}</span>
          <button type="button" className="bw-link-button" onClick={() => { setCommandFilter(null); setQuery(""); setFilter("all"); }}>{m.command.filter.clear}</button>
        </p>
      )}
      {statusLine}
      {manualTools && selected.size > 0 && (
        <div className="bw-panel bw-batch-bar" role="region" aria-label={t("ledger.list.selected", { count: selected.size })}>
          <strong>{t("ledger.list.selected", { count: selected.size })}</strong>
          <label className="bw-inline-field"><span className="bw-sr-only">{L.batchCategory}</span>
            <select value={batchCategory} onChange={(e) => setBatchCategory(e.target.value)}>
              <option value="">{L.batchCategory}</option>
              {categoryChoices(categoryTree, categories.filter((c) => categoryTree.kindOf(c) !== "transfer")).map((c) => <option key={c.name} value={c.name}>{indented(categoryLabel(m, c.name), c.depth)}</option>)}
            </select>
          </label>
          <input aria-label={L.batchMerchant} placeholder={L.batchMerchant} value={batchText.merchant} onChange={(e) => setBatchText({ ...batchText, merchant: e.target.value })} />
          <input aria-label={L.batchProject} placeholder={L.batchProject} value={batchText.project} onChange={(e) => setBatchText({ ...batchText, project: e.target.value })} />
          <input aria-label={L.batchTag} placeholder={L.batchTag} value={batchText.tag} onChange={(e) => setBatchText({ ...batchText, tag: e.target.value })} />
          <button type="button" className="bw-button" onClick={() => run(async () => {
            const changed = await store.ledger.batchUpdate(ids, {
              ...(batchCategory ? { category: batchCategory } : {}), ...(batchText.merchant.trim() ? { merchant: batchText.merchant } : {}),
              ...(batchText.project.trim() ? { project: batchText.project } : {}), ...(batchText.tag.trim() ? { addTags: [batchText.tag] } : {}),
            });
            setSelected(new Set()); setBatchCategory(""); setBatchText({ merchant: "", project: "", tag: "" });
            return changed;
          }, t("ledger.list.batchDone", { count: ids.length }))}>{L.batchApply}</button>
          <button type="button" className="bw-button bw-button-danger-outline" onClick={() => run(async () => { await store.ledger.deleteEntries(ids); setSelected(new Set()); }, m.ledger.entry.deletedToTrash)}>{L.batchDelete}</button>
        </div>
      )}
      <p className="bw-caption">
        {manualTools && <><label className="bw-check"><input type="checkbox" checked={visible.length > 0 && visible.every((tx) => selected.has(tx.id))} onChange={(e) => setSelected(e.target.checked ? new Set(visible.map((tx) => tx.id)) : new Set())} /> {L.selectAll}</label>{" "}</>}
        {t("transactions.count", { shown: visible.length, total: transactions.length })}
      </p>
      <ul className="bw-tx-table">
        {visible.slice(0, rowLimit).map((transaction) => (
          <li key={transaction.id} className={transaction.excluded ? "is-excluded" : ""}>
            {manualTools && <input type="checkbox" aria-label={t("ledger.list.select", { description: transaction.description })} checked={selected.has(transaction.id)} onChange={() => toggle(transaction.id)} />}
            <div className="bw-tx-main">
              <strong>{transaction.description}</strong>
              <small>
                {transaction.bookedOn}{transaction.time ? ` ${transaction.time}` : ""}
                {transaction.kind && transaction.kind !== "expense" && transaction.kind !== "income" ? ` · ${m.ledger.kinds[transaction.kind]}` : ""}
                {transaction.accountId ? ` · ${accountName.get(transaction.accountId) ?? ""}` : ""}
                {transaction.merchant ? ` · ${transaction.merchant}` : ""}{transaction.project ? ` · ${transaction.project}` : ""}
                {transaction.tags && transaction.tags.length > 0 ? ` · #${transaction.tags.join(" #")}` : ""}
                {transaction.taxReview ? ` · ${x.taxReview}` : ""}{transaction.excluded ? ` · ${x.excluded}` : ""}
              </small>
            </div>
            {transaction.kind === "transfer" || transaction.kind === "card_payment" || transaction.kind === "adjustment"
              ? <span className="bw-tag bw-tag-muted">{m.ledger.kinds[transaction.kind]}</span>
              : <CategorySelect label={t("transactions.categoryFor", { description: transaction.description })} value={transaction.category} categories={categories} lazy onChange={(category) => change(transaction, category)} />}
            <Money cents={transaction.amountCents} currency={codeFor(transaction)} signed />
            <div className="bw-row-actions">
              {manualTools && <>
              <button type="button" className="bw-link-button" onClick={async () => setForm({ entry: await store.ledger.entry(transaction.id) })}>{m.ledger.common.edit}</button>
              <button type="button" className="bw-link-button" onClick={() => run(() => store.ledger.duplicateEntry(transaction.id), m.ledger.entry.copied)}>{m.ledger.entry.copy}</button>
              <button type="button" className="bw-link-button" onClick={() => run(() => store.ledger.deleteEntries([transaction.id]), m.ledger.entry.deletedToTrash)}>{m.ledger.common.delete}</button>
              </>}
              <button type="button" className="bw-link-button" onClick={() => toggleExcluded(transaction)}>{transaction.excluded ? x.include : x.exclude}</button>
            </div>
          </li>
        ))}
      </ul>
      {hidden > 0 && (
        <div className="bw-actions">
          <button type="button" className="bw-button bw-button-outline" onClick={() => setShown({ key: filterKey, rows: rowLimit + PAGE_ROWS })}>
            {t("transactions.showMore", { count: Math.min(PAGE_ROWS, hidden) })}
          </button>
        </div>
      )}
    </>
  );
}
