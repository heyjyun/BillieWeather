import { icons } from "@billie/design-tokens";
import { useEffect, useState } from "react";
import { emailOwnerKey, ownerKeyFor } from "./services/databases";
import { AccountProvider, useAccount } from "./hooks/useAccount";
import { FinanceProvider, useFinance } from "./hooks/useFinance";
import { I18nProvider, useI18n } from "./i18n";
import { Dashboard } from "./pages/Dashboard";
import { Categories } from "./pages/Categories";
import { Data } from "./pages/Data";
import { Import } from "./pages/Import";
import { Login } from "./pages/Login";
import { Reports } from "./pages/Reports";
import { Settings } from "./pages/Settings";
import { Transactions } from "./pages/Transactions";
import { Accounts } from "./pages/Accounts";
import { Planning } from "./pages/Planning";
import { Lists } from "./pages/Lists";
import { SyncStatus } from "./components/SyncStatus";
import { CommandCenter } from "./components/CommandCenter";
import type { TransactionFilter } from "./commands/handlers";
import { saveSidebarCollapsed, savedSidebarCollapsed } from "./services/theme";

export type Page = "dashboard" | "transactions" | "accounts" | "categories" | "planning" | "lists" | "import" | "reports" | "data" | "settings";

const NAV: Array<{ page: Page; icon: string }> = [
  { page: "dashboard", icon: icons.dashboard },
  { page: "transactions", icon: icons.transactions },
  { page: "accounts", icon: icons.insights },
  { page: "categories", icon: icons.tag },
  { page: "planning", icon: icons.forecast },
  { page: "lists", icon: icons.file },
  { page: "import", icon: icons.upload },
  { page: "reports", icon: icons.file },
  { page: "data", icon: icons.data },
  { page: "settings", icon: icons.settings },
];

function Icon({ d }: { d: string }) {
  return <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={d} /></svg>;
}

function Shell() {
  const { m } = useI18n();
  const { account } = useAccount();
  const [page, setPage] = useState<Page>("dashboard");
  // A part of a page to bring into view after navigating (e.g. the sync panel on the Data page).
  const [focus, setFocus] = useState<string | null>(null);
  // A filter set by a typed command ("show coffee last month"); `key` remounts the page with it.
  const [transactionFilter, setTransactionFilter] = useState<{ key: number; filter: TransactionFilter } | null>(null);
  const go = (next: Page, part: string | null = null, filter?: TransactionFilter) => {
    setFocus(part);
    setTransactionFilter(filter ? { key: Date.now(), filter } : null);
    setPage(next);
  };
  const { persistent } = useFinance();
  const navLabel = (target: Page) => (target === "accounts" || target === "planning" || target === "lists" ? m.ledger.nav[target] : m.nav[target]);
  const [collapsed, setCollapsed] = useState(savedSidebarCollapsed);
  const toggleSidebar = () => setCollapsed((was) => { saveSidebarCollapsed(!was); return !was; });
  return (
    <div className={collapsed ? "bw-app is-collapsed" : "bw-app"}>
      <nav className="bw-nav" id="bw-nav" aria-label={m.nav.main}>
        <div className="bw-nav-head">
          <div className="bw-brand"><span className="bw-brand-mark" aria-hidden="true">b<small>·</small></span><span className="bw-brand-name">BillieWeather</span></div>
          <button type="button" className="bw-nav-toggle" aria-controls="bw-nav" aria-expanded={!collapsed} aria-label={collapsed ? m.nav.expand : m.nav.collapse} title={collapsed ? m.nav.expand : m.nav.collapse} onClick={toggleSidebar}>
            <Icon d={icons.collapse} />
          </button>
        </div>
        <ul>
          {NAV.map((item) => (
            <li key={item.page}>
              <button type="button" className={page === item.page ? "bw-nav-item is-active" : "bw-nav-item"} title={collapsed ? navLabel(item.page) : undefined} aria-current={page === item.page ? "page" : undefined} onClick={() => go(item.page)}>
                <Icon d={item.icon} /><span>{navLabel(item.page)}</span>
              </button>
            </li>
          ))}
        </ul>
        <div className="bw-nav-bottom">
          <p className="bw-nav-note"><Icon d={icons.lock} /><span>{m.nav.note}</span></p>
          {account && <p className="bw-nav-user"><strong>{account.nickname || account.email}</strong>{account.nickname && <small>{account.email}</small>}</p>}
        </div>
      </nav>
      <main className="bw-main" id="main">
        {!persistent && <p className="bw-preview-banner">{m.preview}</p>}
        <CommandCenter go={go} />
        <SyncStatus />
        {page === "dashboard" && <Dashboard go={go} />}
        {page === "transactions" && <Transactions key={transactionFilter?.key ?? 0} preset={transactionFilter?.filter} />}
        {page === "accounts" && <Accounts />}
        {page === "categories" && <Categories key={focus ?? ""} focus={focus} />}
        {page === "planning" && <Planning />}
        {page === "lists" && <Lists />}
        {page === "import" && <Import />}
        {page === "reports" && <Reports />}
        {page === "data" && <Data focus={focus} />}
        {page === "settings" && <Settings />}
        <footer className="bw-footer">{m.footer}</footer>
      </main>
    </div>
  );
}

function Gate() {
  const { status, account } = useAccount();
  const { m } = useI18n();
  // Which account owns the databases this session may open (review P0-1). A new key remounts the
  // provider, so switching accounts never keeps another account's database open.
  const [keys, setKeys] = useState<{ owner: string; email: string } | null>(null);
  const ownerId = account?.ownerId ?? null;
  const email = account?.email ?? null;
  useEffect(() => {
    if (!email) {
      setKeys(null);
      return;
    }
    let cancelled = false;
    Promise.all([ownerKeyFor({ ownerId, email }), emailOwnerKey(email)]).then(([owner, emailKey]) => { if (!cancelled) setKeys({ owner, email: emailKey }); });
    return () => { cancelled = true; };
  }, [ownerId, email]);
  if (status === "loading") return <div className="bw-boot">{m.boot.opening}</div>;
  if (status === "signedOut") return <Login />;
  if (!keys) return <div className="bw-boot">{m.boot.opening}</div>;
  return <FinanceProvider key={keys.owner} ownerKey={keys.owner} emailKey={keys.email}><Shell /></FinanceProvider>;
}

export default function App() {
  return <I18nProvider><AccountProvider><Gate /></AccountProvider></I18nProvider>;
}
