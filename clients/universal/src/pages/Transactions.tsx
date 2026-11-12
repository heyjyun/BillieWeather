import type { Category, Transaction } from "@billie/shared-types";
import { allCategories, formatMoney, merchantKey } from "@billie/finance-core";
import { formatRange } from "@nlae/core";
import { matchTransactions, type TransactionFilter } from "../commands/handlers";
import { useMemo, useState } from "react";
import { CategorySelect, Empty, Money, PageHeading } from "../components/common";
import { useFinance } from "../hooks/useFinance";
import { categoryLabel, useI18n } from "../i18n";

/** `preset`: a filter from a typed command; it stays until the person changes the filters or clears it. */
export function Transactions({ preset }: { preset?: TransactionFilter } = {}) {
  const { m, t } = useI18n();
  const { transactions, customCategories, currency, store, refresh } = useFinance();
  const categories = useMemo(() => allCategories(customCategories), [customCategories]);
  const [query, setQuery] = useState(preset?.query ?? "");
  const [filter, setFilter] = useState<Category | "all">(preset?.category ?? "all");
  const [commandFilter, setCommandFilter] = useState<TransactionFilter | null>(preset && (preset.period || preset.amount || preset.query) ? preset : null);
  const [remember, setRemember] = useState(true);
  const [status, setStatus] = useState("");
  const cur = currency ?? "USD";
  const x = m.transactions;

  const visible = useMemo(() => {
    // A command's filter uses the same matching as the command's own count.
    if (commandFilter) return matchTransactions(transactions, { ...commandFilter, category: filter === "all" ? undefined : filter });
    const q = query.trim().toLowerCase();
    return transactions.filter((transaction) => (filter === "all" || transaction.category === filter) && (!q || transaction.description.toLowerCase().includes(q)));
  }, [transactions, query, filter, commandFilter]);
  const commandSummary = commandFilter && [
    commandFilter.query ? `“${commandFilter.query}”` : null,
    commandFilter.period ? formatRange(commandFilter.period) : null,
    commandFilter.amount ? `${{ eq: "=", gt: ">", gte: "≥", lt: "<", lte: "≤" }[commandFilter.amount.comparator]} ${formatMoney(commandFilter.amount.amountMinor, commandFilter.amount.currency ?? cur)}` : null,
  ].filter(Boolean).join(" · ");

  async function change(transaction: Transaction, category: Category) {
    const others = await store.setCategory(transaction.id, category, remember);
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
    await store.setExcluded(transaction.id, !transaction.excluded);
    await refresh();
    setStatus(transaction.excluded ? x.included : x.excludedStatus);
  }

  if (transactions.length === 0) return <><PageHeading eyebrow={x.eyebrow} title={x.title} /><Empty title={x.emptyTitle} body={x.emptyBody} /></>;

  return (
    <>
      <PageHeading eyebrow={x.eyebrow} title={x.title} />
      <div className="bw-filter-bar">
        <label className="bw-field bw-grow"><span>{x.search}</span><input type="search" value={query} onChange={(e) => { setCommandFilter(null); setQuery(e.target.value); }} placeholder={x.searchPlaceholder} /></label>
        <label className="bw-field"><span>{x.category}</span>
          <select value={filter} onChange={(e) => setFilter(e.target.value as Category | "all")}>
            <option value="all">{x.allCategories}</option>
            {categories.map((c) => <option key={c} value={c}>{categoryLabel(m, c)}</option>)}
          </select>
        </label>
        <label className="bw-check"><input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} /> {x.remember}</label>
      </div>
      {commandSummary && (
        <p className="bw-command-filter">
          <span>{t("command.filter.active", { filter: commandSummary })}</span>
          <button type="button" className="bw-link-button" onClick={() => { setCommandFilter(null); setQuery(""); setFilter("all"); }}>{m.command.filter.clear}</button>
        </p>
      )}
      <p className="bw-sr-status" role="status" aria-live="polite">{status}</p>
      <p className="bw-caption">{t("transactions.count", { shown: visible.length, total: transactions.length })}</p>
      <ul className="bw-tx-table">
        {visible.map((transaction) => (
          <li key={transaction.id} className={transaction.excluded ? "is-excluded" : ""}>
            <div className="bw-tx-main">
              <strong>{transaction.description}</strong>
              <small>{transaction.bookedOn}{transaction.taxReview ? ` · ${x.taxReview}` : ""}{transaction.excluded ? ` · ${x.excluded}` : ""}</small>
            </div>
            <CategorySelect label={t("transactions.categoryFor", { description: transaction.description })} value={transaction.category} categories={categories} onChange={(category) => change(transaction, category)} />
            <Money cents={transaction.amountCents} currency={cur} signed />
            <button type="button" className="bw-link-button" onClick={() => toggleExcluded(transaction)}>{transaction.excluded ? x.include : x.exclude}</button>
          </li>
        ))}
      </ul>
    </>
  );
}
