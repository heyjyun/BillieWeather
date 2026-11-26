import type { Category, Transaction } from "@billie/shared-types";
import { allCategories, CATEGORY_MAX, CATEGORY_NAME_MAX, categoryTrend, type CategoryTree as CategoryIndex, formatMoney, inSubtree, merchantKey, rollUp, spendingByMonth, spendingMix, spendingPalette, spendingTone, SYSTEM_KEYS, topMerchants, UNCATEGORIZED } from "@billie/finance-core";
import { useMemo, useState, type FormEvent } from "react";
import { CategoryBadge, CategorySelect, indented, Money, PageHeading } from "../components/common";
import { CategoryInsights, MonthlySpendingChart, SpendingMixChart } from "../components/SpendingCharts";
import { CategoryTree } from "../components/CategoryTree";
import { AiCategorizePanel } from "../components/AiCategorizePanel";
import { useMode } from "../hooks/useMode";
import { useFinance } from "../hooks/useFinance";
import { categoryLabel, useI18n } from "../i18n";
import { StoreError } from "../services/store";

interface CategoryRow {
  name: Category;
  /** Depth in the tree (0 for a top-level category and Uncategorized). */
  depth: number;
  custom: boolean;
  count: number;
  outCents: number;
  inCents: number;
  share: number | null;
  latest: string | null;
}

/**
 * Totals for every category over all of this database's transactions, in tree order. A category's
 * totals include its subcategories' (a category always means itself plus its descendants).
 */
function categoryRows(transactions: readonly Transaction[], categories: readonly Category[], tree: CategoryIndex): CategoryRow[] {
  const depth = new Map(tree.flatten({ includeHidden: true }).map((node) => [node.name, node.depth]));
  const ordered = [...tree.names().filter((name) => categories.includes(name)), ...categories.filter((name) => !tree.has(name))];
  const rows = new Map<string, CategoryRow>(ordered.map((name) => [name.toLowerCase(), { name, depth: depth.get(name) ?? 0, custom: tree.has(name) && !tree.get(name)!.key, count: 0, outCents: 0, inCents: 0, share: null, latest: null }]));
  for (const transaction of transactions) {
    const names = tree.has(transaction.category) ? [...tree.ancestors(transaction.category), tree.canonical(transaction.category)!] : [transaction.category];
    for (const name of names) {
      const row = rows.get(name.toLowerCase()) ?? { name, depth: 0, custom: false, count: 0, outCents: 0, inCents: 0, share: null, latest: null };
      row.count += 1;
      if (!transaction.excluded) {
        if (transaction.amountCents < 0) row.outCents -= transaction.amountCents;
        else row.inCents += transaction.amountCents;
      }
      if (!row.latest || transaction.bookedOn > row.latest) row.latest = transaction.bookedOn;
      rows.set(name.toLowerCase(), row);
    }
  }
  // Shares of spending among top-level categories (transfers never count).
  const counted = (row: CategoryRow) => row.depth === 0 && tree.kindOf(row.name) !== "transfer";
  const spending = [...rows.values()].filter(counted).reduce((sum, row) => sum + row.outCents, 0);
  for (const row of rows.values()) row.share = tree.kindOf(row.name) !== "transfer" && spending > 0 && row.outCents > 0 ? row.outCents / spending : null;
  return [...rows.values()];
}

export function Categories({ focus = null }: { focus?: string | null } = {}) {
  const { manual } = useMode();
  const { m, t } = useI18n();
  const { transactions, customCategories, categoryTree: tree, currency, store, refresh } = useFinance();
  const x = m.categoryPage;
  const cur = currency ?? "USD";
  const categories = useMemo(() => allCategories(customCategories), [customCategories]);
  const rows = useMemo(() => categoryRows(transactions, categories, tree), [transactions, categories, tree]);
  const [selected, setSelected] = useState<Category | null>(() => (focus && categories.includes(focus) ? focus : null));
  const [newName, setNewName] = useState("");
  const [renameTo, setRenameTo] = useState(() => focus ?? "");
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  // Charts group by top-level category (subcategories roll up into them).
  const byRoot = useMemo(() => rollUp(transactions, tree), [transactions, tree]);
  const palette = useMemo(() => spendingPalette(byRoot), [byRoot]);
  const mix = useMemo(() => spendingMix(byRoot, palette), [byRoot, palette]);
  const monthly = useMemo(() => spendingByMonth(byRoot, palette), [byRoot, palette]);
  const uncategorized = rows.find((row) => row.name === UNCATEGORIZED)?.count ?? 0;

  function say(message: string, isError = false) {
    setStatus(isError ? "" : message);
    setError(isError ? message : "");
  }

  function categoryError(caught: unknown): string {
    if (caught instanceof StoreError && caught.code === "too_many_categories") return t("categoryPage.errorTooMany", { max: CATEGORY_MAX });
    if (caught instanceof StoreError && (caught.code === "category_protected" || caught.code === "category_cycle")) return (m.ledger.errors as Record<string, string>)[caught.code];
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
    let moved: number;
    try {
      moved = await store.deleteCategory(selected);
    } catch (caught) {
      return say(categoryError(caught), true);
    }
    await refresh();
    say(t("categoryPage.deleted", { name: selected, count: moved }));
    setSelected(null);
    setConfirmingDelete(false);
  }

  async function change(transaction: Transaction, category: Category) {
    let others: number;
    try {
      others = await store.setCategory(transaction.id, category, true);
    } catch {
      return say(m.ledger.errors.unknown, true);
    }
    await refresh();
    const merchant = merchantKey(transaction.description);
    const vars = { merchant: merchant ?? "", category: categoryLabel(m, category), count: others };
    say(merchant && category !== "Uncategorized" ? t(others ? "transactions.savedRuleOthers" : "transactions.savedRule", vars) : m.transactions.saved);
  }

  const messages = (
    <>
      {status && <p className="bw-message bw-message-ok" role="status">{status}</p>}
      {error && <p className="bw-message bw-message-error" role="alert">{error}</p>}
    </>
  );

  const detail = selected ? rows.find((row) => row.name === selected) : undefined;
  if (selected && detail) {
    // The category with everything below it.
    const inCategory = inSubtree(transactions, tree, selected);
    const asOne = inCategory.map((transaction) => ({ ...transaction, category: selected }));
    const protectedCategory = tree.get(selected)?.key === SYSTEM_KEYS.transfers;
    return (
      <>
        <PageHeading eyebrow={x.detailEyebrow} title={categoryLabel(m, selected)}>
          <button type="button" className="bw-button bw-button-outline" onClick={() => { setSelected(null); say(""); }}>← {x.back}</button>
        </PageHeading>
        {messages}
        <p className="bw-caption">{t("categoryPage.detailSummary", { count: detail.count, out: formatMoney(detail.outCents, cur), in: formatMoney(detail.inCents, cur) })}</p>
        <section className="bw-panel bw-cat-insights-panel" aria-label={m.spending.trendTitle}>
          <CategoryInsights trend={categoryTrend(asOne, selected)} merchants={topMerchants(asOne, selected)} tone={spendingTone(palette, tree.rootOf(selected)?.name ?? selected)} spentCents={detail.outCents} currency={cur} />
        </section>
        {tree.has(selected) && (
          <section className="bw-panel bw-cat-manage">
            <form className="bw-cat-form" onSubmit={rename}>
              <label className="bw-field bw-grow"><span>{x.renameLabel}</span><input value={renameTo} maxLength={CATEGORY_NAME_MAX} required onChange={(e) => setRenameTo(e.target.value)} /></label>
              <button type="submit" className="bw-button bw-button-outline">{x.rename}</button>
            </form>
            {!confirmingDelete && !protectedCategory && <button type="button" className="bw-button bw-button-danger" onClick={() => setConfirmingDelete(true)}>{x.delete}</button>}
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
        <AiCategorizePanel uncategorized={uncategorized} say={say} />
        <section className="bw-panel" aria-labelledby="custom-heading">
          <h2 id="custom-heading">{x.customTitle}</h2>
          <p>{t("categoryPage.customBody", { max: CATEGORY_MAX })}</p>
          <form className="bw-cat-form" onSubmit={add}>
            <label className="bw-field bw-grow"><span>{x.newName}</span><input value={newName} maxLength={CATEGORY_NAME_MAX} placeholder={x.newPlaceholder} required onChange={(e) => setNewName(e.target.value)} /></label>
            <button type="submit" className="bw-button">{x.add}</button>
          </form>
        </section>
      </div>
      {manual ? <CategoryTree /> : (
        <details className="bw-panel bw-section-gap">
          <summary>{m.ledger.categoriesTree.title}</summary>
          <CategoryTree />
        </details>
      )}
      <div className="bw-two-column bw-section-gap">
        <section className="bw-panel" id="categories-spending-monthly" aria-labelledby="monthly-heading">
          <span className="bw-eyebrow">{m.spending.monthlyEyebrow}</span>
          <h2 id="monthly-heading">{m.spending.monthlyTitle}</h2>
          <p className="bw-caption bw-viz-intro">{t("spending.monthlyBody", { count: monthly.length })}</p>
          <MonthlySpendingChart months={monthly} currency={cur} />
        </section>
        <section className="bw-panel" id="categories-spending-mix" aria-labelledby="mix-heading">
          <span className="bw-eyebrow">{m.spending.eyebrow}</span>
          <h2 id="mix-heading">{m.spending.mixTitle}</h2>
          <p className="bw-caption bw-viz-intro">{m.spending.mixBodyAll}</p>
          <SpendingMixChart mix={mix} currency={cur} emptyText={m.spending.noSpending} onOpen={open} />
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
                  <td>{indented("", row.depth)}{row.depth === 0 && row.outCents > 0 && tree.kindOf(row.name) !== "transfer" && <i className={`bw-viz-swatch bw-viz-${spendingTone(palette, row.name)} bw-cat-swatch`} aria-hidden="true" />}<CategoryBadge category={row.name} />{row.custom && <small className="bw-cat-kind"> {x.custom}</small>}</td>
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

