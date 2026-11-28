import { createPortal } from "react-dom";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { organizeProposals, kindOf, localToday, resolvePeriod } from "@billie/finance-core";
import { mountNext, type AssistantState, type NextFacts, type Suggestion } from "../../../../public/next-steps.mjs";
import labels from "../../../../packages/shared-types/schema/assistant-copy.json";
import { useAccount } from "../hooks/useAccount";
import { useFinance } from "../hooks/useFinance";
import { useI18n } from "../i18n";
import { assistantState, saveAssistantChoice, syncAssistantChoices } from "../services/assistantPreferences";
import type { Page, TransactionIntent } from "../App";
import type { TransactionFilter } from "../commands/handlers";
import { organizeRows } from "../services/organize";
import { statementObservations } from "../services/statementObservations";
import { localSources, currencyLookup } from "../overview/local";

type Go = (page: Page, focus?: string | null, filter?: TransactionFilter, intent?: TransactionIntent) => void;
export function NextStep({page, focus, go}: {page: Page; focus: string | null; go: Go}) {
  const { locale } = useI18n();
  const { getToken } = useAccount();
  const finance = useFinance();
  const { accounts, currency, transactions, statements, store, syncEnabled, ownerKey } = finance;
  const root = useRef<HTMLDivElement>(null);
  const [slot,setSlot] = useState<HTMLElement | null>(null);
  useLayoutEffect(() => {
    const selector = page === "accounts" ? "[data-account-next-slot]" : "[data-next-slot]";
    setSlot(page === "settings" ? null : document.querySelector<HTMLElement>("#main " + selector));
  },[page,focus]);
  const navigate = useRef(go);
  navigate.current = go;
  const [version, setVersion] = useState(0);
  const [settings, setSettings] = useState<AssistantState | null>(null);
  const [error, setError] = useState("");
  const sync = () => {
    const token = getToken();
    return token && ownerKey && syncEnabled ? syncAssistantChoices(store, token) : Promise.resolve();
  };
  useEffect(() => {
    let active = true;
    const run = () => void sync().then(() => { if (active) setVersion(n => n + 1); }).catch(() => {});
    run();
    window.addEventListener("online", run);
    return () => { active = false; window.removeEventListener("online", run); };
  }, [store, ownerKey, getToken, syncEnabled]);

  useEffect(() => {
    const node = root.current;
    if (!node) return;
    let current = true;
    node.replaceChildren();
    async function render() {
      const state = await assistantState(store);
      if (!current) return;
      setSettings(state);
      if (page === "settings" || state.enabled === false) return;
      const day = localToday();
      const start = String(Number(day.slice(0,4)) - 1) + day.slice(4);
      const code = currencyLookup(accounts, statements, currency || "USD");
      const history = transactions.filter(t => code(t) === (currency || "USD") && !t.excluded && t.bookedOn >= start && t.bookedOn <= day);
      const months: Record<string,number> = {};
      for (const t of history) {
        const month = t.bookedOn.slice(0,7);
        if (month < day.slice(0,7) && ["expense","refund"].includes(kindOf(t))) months[month] = (months[month] || 0) - t.amountCents;
      }
      const [budgets, schedules, links] = await store.sql.snapshot<{n: number; name: string; kind: string}>([
        {sql:"SELECT COUNT(*) AS n FROM budgets"}, {sql:"SELECT name FROM recurring_rules"},
        {sql:"SELECT l.link_type AS kind,COUNT(*) AS n FROM transaction_links l JOIN transactions t ON t.id=l.from_transaction_id WHERE l.status='suggested' AND t.deleted_at IS NULL GROUP BY l.link_type"},
      ]);
      if (!current || !node) return;
      const sources = localSources(finance, {account:"", currency:currency || "USD", period:resolvePeriod("all_time",{today:day})},day,name=>name);
      const [projection, remaining, evidence, rows] = await Promise.all([sources.forecast(),budgets[0]?.n ? sources.budget() : null,statementObservations(store,day),
        transactions.length ? organizeRows(store.sql, 250) : Promise.resolve([])]);
      const liability = new Set(accounts.filter(a => a.accountClass === "liability").map(a => a.id));
      const proposals = organizeProposals(rows,{liability:id => liability.has(id)});
      const observations = new Map(evidence.map(r=>[r.id,[r.day,currency,(r.cents/100).toFixed(2)].join(" · ")]));
      if (!current) return;
      const counts = Object.fromEntries(links.map(l => [l.kind,l.n]));
      const available = ["account","import","classify","reconcile","duplicates","matches","discover","budget","recurring","report"];
      if (projection.length) available.push("forecast");
      const facts: NextFacts = { accounts: accounts.filter(a => !a.unassigned).map(a => ({...a, observation: observations.get(a.id), pending: a.openingBalanceSource === "unknown"})), currency: currency || "USD",
        transactions: transactions.length, latest: transactions.reduce((max,t) => t.bookedOn <= day && t.bookedOn > max ? t.bookedOn : max,""), statements: statements.length,
        unclassified: transactions.filter(t => !t.excluded && t.category === "Uncategorized" && ["expense","income","refund"].includes(kindOf(t))).length,
        duplicates: Math.max(counts.duplicate_of || 0, proposals.filter(p => p.type === "duplicate").length), matches: proposals.filter(p => p.type === "transfer" || p.type === "card_payment").length, budgets: budgets[0]?.n || 0, remaining, scheduled: schedules.map(s => s.name),
        forecastReady: projection.length > 0, shortfall: projection.slice(1,31).find(point => point.balance < 0)?.date, months, available, recent: history.filter(t => ["transfer","card_payment","expense"].includes(kindOf(t)))
          .sort((a,b) => b.bookedOn.localeCompare(a.bookedOn) || b.id-a.id).slice(0,120)
          .map(t => ({id:t.id, date:t.bookedOn, description:t.description, kind:kindOf(t), cents:t.amountCents})) };
      const choose = ({kind,target}: Suggestion) => {
        const open = navigate.current;
        switch (kind) {
          case "account": return open("accounts");
          case "discover": return open("accounts","discover-" + target);
          case "reconcile": return open("accounts","adjust-" + target);
          case "classify": return open("transactions", null, {category:"Uncategorized"});
          case "duplicates": case "matches": return open("transactions",null,undefined,{view:"organize"});
          case "budget": return open("planning","budget-" + target);
          case "recurring": return open("planning","schedules");
          case "forecast": return open("dashboard","forecast");
          case "report": return open("reports");
          case "import": return open("import");
        }
      };
      mountNext(node, {facts, page:page === "dashboard" && focus === "forecast" ? "forecast" : page === "planning" ? (focus === "schedules" ? "recurring" : "budgets") : page, state, copy:labels[locale], choose,
        save: async (key,value,expected) => { await saveAssistantChoice(store,key,value,expected); void sync().catch(() => {}); }});
    }
    void render().catch(() => {});
    return () => { current = false; node.replaceChildren(); };
  }, [page,focus,slot,version,store,accounts,currency,transactions,statements,locale]);
  const panel = <div ref={root} />;
  return <>{slot?.isConnected ? createPortal(panel,slot) : panel}{page === "settings" && settings && <section className="bw-panel">
    <h2>{labels[locale].next}</h2>{(["enabled","organization","planning"] as const).map(key => <label className="bw-checkbox-card" key={key}>
      <input type="checkbox" checked={settings[key] !== false} onChange={async e => {
        const value = e.target.checked;
        try { await saveAssistantChoice(store,key,value); setSettings(old => ({...old,[key]:value})); setError(""); void sync().catch(() => {}); }
        catch { setError(labels[locale].failure); }
      }} /> {labels[locale][key]}</label>)}
    <p className="bw-caption">{labels[locale].controlNotice}</p>{error && <p role="alert">{error}</p>}
  </section>}</>;
}
