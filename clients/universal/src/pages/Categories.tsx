import type { Category, Transaction } from "@billie/shared-types";
import { AI_BATCH_MAX, allCategories, CATEGORY_NAME_MAX, CUSTOM_CATEGORY_MAX, formatMoney, merchantKey, type AiGroup } from "@billie/finance-core";
import { useMemo, useState, type FormEvent } from "react";
import { CategoryBadge, CategorySelect, Money, PageHeading } from "../components/common";
import { useAccount } from "../hooks/useAccount";
import { useFinance } from "../hooks/useFinance";
import { categoryLabel, useI18n } from "../i18n";
import { AccountError } from "../services/account";
import { AiCategorizeError, requestAiCategories } from "../services/aiCategorize";
import { StoreError } from "../services/store";

interface CategoryRow {
  name: Category;
  custom: boolean;
  count: number;
  outCents: number;
  inCents: number;
  share: number | null;
  latest: string | null;
}

/** Totals for every category over all of this database's transactions. */
function categoryRows(transactions: readonly Transaction[], categories: readonly Category[], custom: ReadonlySet<string>): CategoryRow[] {
  const rows = new Map<Category, CategoryRow>(categories.map((name) => [name, { name, custom: custom.has(name), count: 0, outCents: 0, inCents: 0, share: null, latest: null }]));
  for (const transaction of transactions) {
    const row = rows.get(transaction.category) ?? { name: transaction.category, custom: custom.has(transaction.category), count: 0, outCents: 0, inCents: 0, share: null, latest: null };
    row.count += 1;
    if (!transaction.excluded) {
      if (transaction.amountCents < 0) row.outCents -= transaction.amountCents;
      else row.inCents += transaction.amountCents;
    }
    if (!row.latest || transaction.bookedOn > row.latest) row.latest = transaction.bookedOn;
    rows.set(transaction.category, row);
  }
  const spending = [...rows.values()].filter((row) => row.name !== "Transfers").reduce((sum, row) => sum + row.outCents, 0);
  for (const row of rows.values()) row.share = row.name !== "Transfers" && spending > 0 && row.outCents > 0 ? row.outCents / spending : null;
  return [...rows.values()];
}

type AiState =
  | { step: "idle" }
  | { step: "consent"; groups: AiGroup[]; batch: AiGroup[]; transactions: number }
  | { step: "working" };

export function Categories() {
  const { m, t } = useI18n();
  const { getToken, expire } = useAccount();
  const { transactions, customCategories, currency, store, refresh } = useFinance();
  const x = m.categoryPage;
  const cur = currency ?? "USD";
  const categories = useMemo(() => allCategories(customCategories), [customCategories]);
  const rows = useMemo(() => categoryRows(transactions, categories, new Set(customCategories)), [transactions, categories, customCategories]);
  const [selected, setSelected] = useState<Category | null>(null);
  const [newName, setNewName] = useState("");
  const [renameTo, setRenameTo] = useState("");
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [ai, setAi] = useState<AiState>({ step: "idle" });
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const uncategorized = rows.find((row) => row.name === "Uncategorized")?.count ?? 0;

  function say(message: string, isError = false) {
    setStatus(isError ? "" : message);
    setError(isError ? message : "");
  }

  function categoryError(caught: unknown): string {
    if (caught instanceof StoreError && caught.code === "too_many_categories") return t("categoryPage.errorTooMany", { max: CUSTOM_CATEGORY_MAX });
    if (caught instanceof StoreError && caught.code === "invalid_category") {
      const problem = String(caught.vars.problem);
      if (problem === "too_long") return t("categoryPage.errorTooLong", { max: CATEGORY_NAME_MAX });
      if (problem === "reserved") return x.errorReserved;
      if (problem === "taken") return x.errorTaken;
      return x.errorBlank;
    }
    throw caught;
  }

  async function add(event: FormEvent) {
    event.preventDefault();
    try {
      const name = await store.addCategory(newName);
      await refresh();
      setNewName("");
      say(t("categoryPage.added", { name }));
    } catch (caught) {
      say(categoryError(caught), true);
    }
  }

  function open(name: Category) {
    setSelected(name);
    setRenameTo(name);
    setConfirmingDelete(false);
    say("");
  }

  async function rename(event: FormEvent) {
    event.preventDefault();
    if (!selected) return;
    try {
      const name = await store.renameCategory(selected, renameTo);
      await refresh();
      setSelected(name);
      setRenameTo(name);
      say(t("categoryPage.renamed", { from: selected, name }));
    } catch (caught) {
      say(categoryError(caught), true);
    }
  }

  async function remove() {
    if (!selected) return;
    const moved = await store.deleteCategory(selected);
    await refresh();
    say(t("categoryPage.deleted", { name: selected, count: moved }));
    setSelected(null);
    setConfirmingDelete(false);
  }

  async function change(transaction: Transaction, category: Category) {
    const others = await store.setCategory(transaction.id, category, true);
    await refresh();
    const merchant = merchantKey(transaction.description);
    const vars = { merchant: merchant ?? "", category: categoryLabel(m, category), count: others };
    say(merchant && category !== "Uncategorized" ? t(others ? "transactions.savedRuleOthers" : "transactions.savedRule", vars) : m.transactions.saved);
  }

  async function startAi() {
    say("");
    const groups = await store.aiCandidates();
    const batch = groups.slice(0, AI_BATCH_MAX);
    setAi({ step: "consent", groups, batch, transactions: batch.reduce((sum, group) => sum + group.ids.length, 0) });
  }

  async function runAi(groups: AiGroup[], batch: AiGroup[]) {
    setAi({ step: "working" });
    try {
      const token = getToken();
      if (!token) throw new AccountError("unauthorized");
      const assignments = await requestAiCategories(token, batch.map(({ key, text, direction }) => ({ key, text, direction })), customCategories);
      const changed = await store.applyAiCategories(batch, assignments);
      await refresh();
      const remaining = groups.length - batch.length;
      say([t("categoryPage.aiDone", { count: changed, sent: batch.length }), remaining > 0 ? t("categoryPage.aiRemaining", { count: remaining }) : ""].filter(Boolean).join(" "));
    } catch (caught) {
      if (caught instanceof AccountError && caught.code === "unauthorized") {
        await expire();
        return;
      }
      if (caught instanceof AccountError) say(x.aiErrorOffline, true);
      else if (caught instanceof AiCategorizeError) say(caught.code === "wait" ? x.aiErrorWait : caught.code === "not_configured" ? x.aiErrorNotConfigured : x.aiErrorFailed, true);
      else throw caught;
    } finally {
      setAi((current) => (current.step === "working" ? { step: "idle" } : current));
    }
  }

  const messages = (
    <>
      {status && <p className="bw-message bw-message-ok" role="status">{status}</p>}
      {error && <p className="bw-message bw-message-error" role="alert">{error}</p>}
    </>
  );

  const detail = selected ? rows.find((row) => row.name === selected) : undefined;
  if (selected && detail) {
    const inCategory = transactions.filter((transaction) => transaction.category === selected);
    return (
      <>
        <PageHeading eyebrow={x.detailEyebrow} title={categoryLabel(m, selected)}>
          <button type="button" className="bw-button bw-button-outline" onClick={() => { setSelected(null); say(""); }}>← {x.back}</button>
        </PageHeading>
        {messages}
        <p className="bw-caption">{t("categoryPage.detailSummary", { count: detail.count, out: formatMoney(detail.outCents, cur), in: formatMoney(detail.inCents, cur) })}</p>
        {detail.custom && (
          <section className="bw-panel bw-cat-manage">
            <form className="bw-cat-form" onSubmit={rename}>
              <label className="bw-field bw-grow"><span>{x.renameLabel}</span><input value={renameTo} maxLength={CATEGORY_NAME_MAX} required onChange={(e) => setRenameTo(e.target.value)} /></label>
              <button type="submit" className="bw-button bw-button-outline">{x.rename}</button>
            </form>
            {!confirmingDelete && <button type="button" className="bw-button bw-button-danger" onClick={() => setConfirmingDelete(true)}>{x.delete}</button>}
            {confirmingDelete && (
              <div className="bw-confirm" role="alertdialog" aria-label={x.delete}>
                <p>{t("categoryPage.deleteConfirm", { name: selected, count: detail.count })}</p>
                <button type="button" className="bw-button bw-button-danger" onClick={remove}>{x.confirmDelete}</button>
                <button type="button" className="bw-link-button" onClick={() => setConfirmingDelete(false)}>{x.cancel}</button>
              </div>
            )}
          </section>
        )}
        {inCategory.length === 0 ? (
          <div className="bw-empty"><h2>{x.detailEmpty}</h2><p>{x.detailEmptyBody}</p></div>
        ) : (
          <ul className="bw-tx-table">
            {inCategory.map((transaction) => (
              <li key={transaction.id} className={transaction.excluded ? "is-excluded" : ""}>
                <div className="bw-tx-main">
                  <strong>{transaction.description}</strong>
                  <small>{transaction.bookedOn}{transaction.excluded ? ` · ${m.transactions.excluded}` : ""}</small>
                </div>
                <CategorySelect label={t("categoryPage.categoryFor", { description: transaction.description })} value={transaction.category} categories={categories} onChange={(category) => change(transaction, category)} />
                <Money cents={transaction.amountCents} currency={cur} signed />
              </li>
            ))}
          </ul>
        )}
      </>
    );
  }

  return (
    <>
      <PageHeading eyebrow={x.eyebrow} title={x.title} />
      <p className="bw-muted">{x.intro}</p>
      {messages}
      <div className="bw-db-grid">
        <section className="bw-panel" aria-labelledby="ai-heading">
          <h2 id="ai-heading">{x.aiTitle}</h2>
          <p>{uncategorized > 0 ? t("categoryPage.aiBody", { count: uncategorized }) : x.aiNone}</p>
          {ai.step === "idle" && <button type="button" className="bw-button bw-button-dark" disabled={uncategorized === 0} onClick={startAi}>{x.aiStart}</button>}
          {ai.step === "working" && <p className="bw-caption" role="status">{x.aiWorking}</p>}
          {ai.step === "consent" && (
            <div className="bw-consent" role="dialog" aria-labelledby="ai-consent-heading">
              <h3 id="ai-consent-heading">{x.aiConsentTitle}</h3>
              <p>{t("categoryPage.aiConsentBody", { merchants: ai.batch.length, count: ai.transactions })}</p>
              <p><strong>{x.aiPreview}</strong></p>
              <ul className="bw-consent-preview">
                {ai.batch.slice(0, 8).map((group) => <li key={group.key}><code>{group.text}</code> <small>({group.direction === "in" ? m.settings.moneyIn : m.settings.moneyOut})</small></li>)}
                {ai.batch.length > 8 && <li>{t("categoryPage.aiPreviewMore", { count: ai.batch.length - 8 })}</li>}
                {customCategories.length > 0 && <li>{x.customTitle}: {customCategories.join(", ")}</li>}
              </ul>
              <p className="bw-caption">{x.aiNotSent}</p>
              <div className="bw-db-actions">
                <button type="button" className="bw-button bw-button-dark" disabled={ai.batch.length === 0} onClick={() => runAi(ai.groups, ai.batch)}>{x.aiConfirm}</button>
                <button type="button" className="bw-link-button" onClick={() => setAi({ step: "idle" })}>{x.cancel}</button>
              </div>
            </div>
          )}
          <p className="bw-caption">{x.aiNote}</p>
        </section>
        <section className="bw-panel" aria-labelledby="custom-heading">
          <h2 id="custom-heading">{x.customTitle}</h2>
          <p>{t("categoryPage.customBody", { max: CUSTOM_CATEGORY_MAX })}</p>
          <form className="bw-cat-form" onSubmit={add}>
            <label className="bw-field bw-grow"><span>{x.newName}</span><input value={newName} maxLength={CATEGORY_NAME_MAX} placeholder={x.newPlaceholder} required onChange={(e) => setNewName(e.target.value)} /></label>
            <button type="submit" className="bw-button">{x.add}</button>
          </form>
        </section>
      </div>
      <section className="bw-panel bw-section-gap" aria-labelledby="all-heading">
        <h2 id="all-heading">{x.allTitle}</h2>
        <p className="bw-caption">{x.allBody}</p>
        <div className="bw-table-scroll">
          <table className="bw-cat-table">
            <thead><tr><th scope="col">{x.colCategory}</th><th scope="col">{x.colCount}</th><th scope="col">{x.colOut}</th><th scope="col">{x.colIn}</th><th scope="col">{x.colShare}</th><th scope="col">{x.colLatest}</th><th scope="col"><span className="bw-sr-only">{x.details}</span></th></tr></thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.name}>
                  <td><CategoryBadge category={row.name} />{row.custom && <small className="bw-cat-kind"> {x.custom}</small>}</td>
                  <td>{row.count}</td>
                  <td><Money cents={row.outCents} currency={cur} /></td>
                  <td><Money cents={row.inCents} currency={cur} /></td>
                  <td>{row.share === null ? "—" : `${Math.round(row.share * 100)}%`}</td>
                  <td>{row.latest ?? "—"}</td>
                  <td><button type="button" className="bw-link-button" aria-label={t("categoryPage.detailsFor", { name: categoryLabel(m, row.name) })} onClick={() => open(row.name)}>{x.details}</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="bw-caption">{x.footnote}</p>
      </section>
    </>
  );
}

