import { icons } from "@billie/design-tokens";
import { useState } from "react";
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
import { SyncStatus } from "./components/SyncStatus";
import { saveSidebarCollapsed, savedSidebarCollapsed } from "./services/theme";

export type Page = "dashboard" | "transactions" | "categories" | "import" | "reports" | "data" | "settings";

const NAV: Array<{ page: Page; icon: string }> = [
  { page: "dashboard", icon: icons.dashboard },
  { page: "transactions", icon: icons.transactions },
  { page: "categories", icon: icons.tag },
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
  const go = (next: Page, part: string | null = null) => {
    setFocus(part);
    setPage(next);
  };
  const { persistent } = useFinance();
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
              <button type="button" className={page === item.page ? "bw-nav-item is-active" : "bw-nav-item"} title={collapsed ? m.nav[item.page] : undefined} aria-current={page === item.page ? "page" : undefined} onClick={() => go(item.page)}>
                <Icon d={item.icon} /><span>{m.nav[item.page]}</span>
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
        <SyncStatus />
        {page === "dashboard" && <Dashboard go={go} />}
        {page === "transactions" && <Transactions />}
        {page === "categories" && <Categories key={focus ?? ""} focus={focus} />}
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
  const { status } = useAccount();
  const { m } = useI18n();
  if (status === "loading") return <div className="bw-boot">{m.boot.opening}</div>;
  if (status === "signedOut") return <Login />;
  return <FinanceProvider><Shell /></FinanceProvider>;
}

export default function App() {
  return <I18nProvider><AccountProvider><Gate /></AccountProvider></I18nProvider>;
}
