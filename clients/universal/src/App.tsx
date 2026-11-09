import { useState } from "react";
import { FinanceProvider, useFinance } from "./hooks/useFinance";
import { Dashboard } from "./pages/Dashboard";
import { Import } from "./pages/Import";
import { Reports } from "./pages/Reports";
import { Settings } from "./pages/Settings";
import { Transactions } from "./pages/Transactions";

export type Page = "dashboard" | "transactions" | "import" | "reports" | "settings";

const NAV: Array<{ page: Page; label: string; icon: string }> = [
  { page: "dashboard", label: "Dashboard", icon: "M3 3h7v7H3z M14 3h7v7h-7z M3 14h7v7H3z M14 14h7v7h-7z" },
  { page: "transactions", label: "Transactions", icon: "M3 7h16 M15 3l4 4-4 4 M21 17H5 M9 13l-4 4 4 4" },
  { page: "import", label: "Import", icon: "M12 16V3 M7 8l5-5 5 5 M3 15v5a1 1 0 001 1h16a1 1 0 001-1v-5" },
  { page: "reports", label: "Reports", icon: "M14 2H5v20h14V7z M14 2v6h5 M8 12h8 M8 16h8" },
  { page: "settings", label: "Settings", icon: "M4 7h16 M4 17h16 M9 4v6 M15 14v6" },
];

function Icon({ d }: { d: string }) {
  return <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={d} /></svg>;
}

function Shell() {
  const [page, setPage] = useState<Page>("dashboard");
  const { persistent } = useFinance();
  return (
    <div className="bw-app">
      <nav className="bw-nav" aria-label="Main">
        <div className="bw-brand"><span className="bw-brand-mark">b<small>·</small></span><span>BillieWeather</span></div>
        <ul>
          {NAV.map((item) => (
            <li key={item.page}>
              <button type="button" className={page === item.page ? "is-active" : ""} aria-current={page === item.page ? "page" : undefined} onClick={() => setPage(item.page)}>
                <Icon d={item.icon} /><span>{item.label}</span>
              </button>
            </li>
          ))}
        </ul>
        <p className="bw-nav-note"><Icon d="M5 11h14v10H5z M8 11V7a4 4 0 018 0v4" /><span>Data stays on this device</span></p>
      </nav>
      <main className="bw-main" id="main">
        {!persistent && <p className="bw-preview-banner">Browser preview — data is kept in memory and is not saved.</p>}
        {page === "dashboard" && <Dashboard go={setPage} />}
        {page === "transactions" && <Transactions />}
        {page === "import" && <Import />}
        {page === "reports" && <Reports />}
        {page === "settings" && <Settings />}
        <footer className="bw-footer">BillieWeather provides financial organization and estimates only. It is not individualized financial, legal, or tax advice.</footer>
      </main>
    </div>
  );
}

export default function App() {
  return <FinanceProvider><Shell /></FinanceProvider>;
}
