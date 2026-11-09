import { CATEGORIES, type Category, type Transaction } from "@billie/shared-types";
import { merchantKey } from "@billie/finance-core";
import { useMemo, useState } from "react";
import { Empty, Money, PageHeading } from "../components/common";
import { useFinance } from "../hooks/useFinance";

export function Transactions() {
  const { transactions, currency, store, refresh } = useFinance();
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Category | "all">("all");
  const [remember, setRemember] = useState(true);
  const [status, setStatus] = useState("");
  const cur = currency ?? "USD";

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return transactions.filter((t) => (filter === "all" || t.category === filter) && (!q || t.description.toLowerCase().includes(q)));
  }, [transactions, query, filter]);

  async function change(transaction: Transaction, category: Category) {
    const others = await store.setCategory(transaction.id, category, remember);
    await refresh();
    const merchant = merchantKey(transaction.description);
    setStatus(remember && merchant && category !== "Uncategorized"
      ? `Saved. "${merchant}" will be ${category} from now on${others ? `; ${others} other transaction${others === 1 ? "" : "s"} updated` : ""}.`
      : "Saved.");
  }

  async function toggleExcluded(transaction: Transaction) {
    await store.setExcluded(transaction.id, !transaction.excluded);
    await refresh();
    setStatus(transaction.excluded ? "Counted in totals again." : "Excluded from totals.");
  }

  if (transactions.length === 0) return <><PageHeading eyebrow="EVERY LINE ITEM" title="Transactions" /><Empty title="Nothing here yet" body="Imported transactions appear here." /></>;

  return (
    <>
      <PageHeading eyebrow="EVERY LINE ITEM" title="Transactions" />
      <div className="bw-filter-bar">
        <label className="bw-field bw-grow"><span>Search</span><input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Merchant or description" /></label>
        <label className="bw-field"><span>Category</span>
          <select value={filter} onChange={(e) => setFilter(e.target.value as Category | "all")}>
            <option value="all">All categories</option>
            {CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        </label>
        <label className="bw-check"><input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} /> Remember my category changes for this merchant</label>
      </div>
      <p className="bw-sr-status" role="status" aria-live="polite">{status}</p>
      <p className="bw-caption">{visible.length} of {transactions.length} transactions</p>
      <ul className="bw-tx-table">
        {visible.map((t) => (
          <li key={t.id} className={t.excluded ? "is-excluded" : ""}>
            <div className="bw-tx-main"><strong>{t.description}</strong><small>{t.bookedOn}{t.taxReview ? " · tax review" : ""}{t.excluded ? " · excluded" : ""}</small></div>
            <select aria-label={`Category for ${t.description}`} value={t.category} onChange={(e) => change(t, e.target.value as Category)}>
              {CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
            <Money cents={t.amountCents} currency={cur} signed />
            <button type="button" className="bw-link-button" onClick={() => toggleExcluded(t)}>{t.excluded ? "Include" : "Exclude"}</button>
          </li>
        ))}
      </ul>
    </>
  );
}
