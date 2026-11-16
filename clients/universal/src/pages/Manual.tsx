// The Manual Mode home (手动记账): quick ways to record each entry type, the book's totals, and every
// manual bookkeeping tool grouped by task. It reads the same database as Default Mode.
import type { TransactionKind } from "@billie/shared-types";
import { useEffect, useMemo, useState } from "react";
import type { Page, TransactionIntent } from "../App";
import { Money, PageHeading } from "../components/common";
import { useFinance } from "../hooks/useFinance";
import { useI18n } from "../i18n";

const QUICK_KINDS: TransactionKind[] = ["expense", "income", "transfer", "refund", "adjustment"];

type Go = (page: Page, part?: string | null, filter?: undefined, intent?: TransactionIntent) => void;

export function Manual({ go }: { go: Go }) {
  const { m, t } = useI18n();
  const { store, accounts, transactions, currency } = useFinance();
  const x = m.ledger.manual;
  const cur = currency ?? accounts[0]?.currency ?? "USD";
  const [totals, setTotals] = useState<{ assetsMinor: number; liabilitiesMinor: number; netWorthMinor: number } | null>(null);
  useEffect(() => { void store.ledger.netWorth().then(setTotals); }, [store, accounts, transactions]);
  const recent = useMemo(() => transactions.filter((tx) => tx.origin === "manual" || tx.origin === "recurring").slice(0, 5), [transactions]);
  const activeAccounts = accounts.filter((account) => !account.archived && !account.unassigned).length;

  const groups: Array<{ group: "record" | "organize" | "plan"; tools: Array<{ id: string; title: string; body: string; open: () => void }> }> = [
    { group: "record", tools: [
      { id: "entry", title: m.ledger.entry.add, body: x.tools.entry, open: () => go("transactions", null, undefined, { entryKind: "expense" }) },
      { id: "transactions", title: m.nav.transactions, body: x.tools.transactions, open: () => go("transactions") },
      { id: "review", title: x.tools.reviewTitle, body: x.tools.review, open: () => go("transactions", null, undefined, { view: "trash" }) },
    ] },
    { group: "organize", tools: [
      { id: "accounts", title: m.ledger.nav.accounts, body: t("ledger.manual.tools.accounts", { count: activeAccounts }), open: () => go("accounts") },
      { id: "categories", title: m.nav.categories, body: x.tools.categories, open: () => go("categories") },
      { id: "lists", title: m.ledger.nav.lists, body: x.tools.lists, open: () => go("lists") },
    ] },
    { group: "plan", tools: [
      { id: "planning", title: m.ledger.nav.planning, body: x.tools.planning, open: () => go("planning") },
      { id: "reports", title: m.nav.reports, body: x.tools.reports, open: () => go("reports") },
      { id: "book", title: x.tools.bookTitle, body: x.tools.book, open: () => go("data") },
    ] },
  ];

  return (
    <>
      <PageHeading eyebrow={x.eyebrow} title={x.title} />
      <p className="bw-caption">{x.intro}</p>
      <section className="bw-panel" aria-labelledby="quick-add-heading">
        <h2 id="quick-add-heading">{x.quickAdd}</h2>
        <p className="bw-caption">{x.quickAddBody}</p>
        <div className="bw-actions bw-quick-add">
          {QUICK_KINDS.map((kind) => (
            <button key={kind} type="button" className={kind === "expense" ? "bw-button bw-button-dark" : "bw-button bw-button-outline"} onClick={() => go("transactions", null, undefined, { entryKind: kind })}>{m.ledger.kinds[kind]}</button>
          ))}
        </div>
      </section>
      {totals && (
        <div className="bw-metrics bw-section-gap">
          <div className="bw-metric"><span>{m.ledger.accounts.assets}</span><strong><Money cents={totals.assetsMinor} currency={cur} /></strong></div>
          <div className="bw-metric"><span>{m.ledger.accounts.liabilities}</span><strong><Money cents={totals.liabilitiesMinor} currency={cur} /></strong></div>
          <div className="bw-metric bw-metric-accent"><span>{m.ledger.accounts.netWorth}</span><strong><Money cents={totals.netWorthMinor} currency={cur} signed /></strong></div>
        </div>
      )}
      {groups.map(({ group, tools }) => (
        <section key={group} className="bw-section-gap" aria-labelledby={`tools-${group}`}>
          <h2 className="bw-tool-group-title" id={`tools-${group}`}>{m.ledger.mode.groups[group]}</h2>
          <div className="bw-tool-grid">
            {tools.map((tool) => (
              <button key={tool.id} type="button" className="bw-tool-card" onClick={tool.open}>
                <strong>{tool.title}</strong><small>{tool.body}</small>
              </button>
            ))}
          </div>
        </section>
      ))}
      <section className="bw-panel bw-section-gap" aria-labelledby="recent-manual-heading">
        <h2 id="recent-manual-heading">{x.recent}</h2>
        {recent.length === 0 ? <p className="bw-caption">{x.recentEmpty}</p> : (
          <ul className="bw-tx-table">
            {recent.map((tx) => (
              <li key={tx.id}>
                <div className="bw-tx-main"><strong>{tx.description}</strong><small>{tx.bookedOn}{tx.kind ? ` · ${m.ledger.kinds[tx.kind]}` : ""}</small></div>
                <Money cents={tx.amountCents} currency={cur} signed />
              </li>
            ))}
          </ul>
        )}
      </section>
      <p className="bw-caption bw-section-gap">{x.sameRecords}</p>
    </>
  );
}
