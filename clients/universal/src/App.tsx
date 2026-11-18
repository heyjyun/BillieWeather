import { icons } from "@billie/design-tokens";
import { lazy, Suspense, useEffect, useLayoutEffect, useRef, useState } from "react";
import { emailOwnerKey, ownerKeyFor } from "./services/databases";
import { AccountProvider, useAccount } from "./hooks/useAccount";
import { FinanceProvider, useFinance } from "./hooks/useFinance";
import { I18nProvider, useI18n } from "./i18n";
import { Dashboard } from "./pages/Dashboard";
import { SignedOut } from "./pages/SignedOut";
import { ModeProvider, useMode, type Mode } from "./hooks/useMode";
import { SyncStatus } from "./components/SyncStatus";
import { CommandCenter } from "./components/CommandCenter";
import type { TransactionFilter } from "./commands/handlers";
import type { TransactionKind } from "@billie/shared-types";
import { saveSidebarCollapsed, savedSidebarCollapsed } from "./services/theme";
import { subscribeDeepLinks, type DeepLinkRoute } from "./services/deepLink";
import { markWelcomeDone, shouldShowWelcome } from "./services/onboarding";
import { Welcome } from "./pages/Welcome";
import { BrandMark } from "./components/BrandMark";

// Load secondary workspaces when opened, so startup does not parse the import/report/editor UI.
const Categories = lazy(() => import("./pages/Categories").then((module) => ({ default: module.Categories })));
const Data = lazy(() => import("./pages/Data").then((module) => ({ default: module.Data })));
const Import = lazy(() => import("./pages/Import").then((module) => ({ default: module.Import })));
const Reports = lazy(() => import("./pages/Reports").then((module) => ({ default: module.Reports })));
const Settings = lazy(() => import("./pages/Settings").then((module) => ({ default: module.Settings })));
const Transactions = lazy(() => import("./pages/Transactions").then((module) => ({ default: module.Transactions })));
const Accounts = lazy(() => import("./pages/Accounts").then((module) => ({ default: module.Accounts })));
const Planning = lazy(() => import("./pages/Planning").then((module) => ({ default: module.Planning })));
const Lists = lazy(() => import("./pages/Lists").then((module) => ({ default: module.Lists })));
const Manual = lazy(() => import("./pages/Manual").then((module) => ({ default: module.Manual })));
const Receipt = lazy(() => import("./pages/Receipt").then((module) => ({ default: module.Receipt })));

export type Page = "dashboard" | "manual" | "transactions" | "accounts" | "categories" | "planning" | "lists" | "import" | "receipt" | "reports" | "data" | "settings";

/** Pages that exist only in Manual Mode; opening one (e.g. from a typed command) turns Manual Mode on. */
export const MANUAL_PAGES: ReadonlySet<Page> = new Set<Page>(["manual", "accounts", "planning", "lists"]);

/** What to open on the Transactions page: a new entry of a kind, or the trash / review list. */
export interface TransactionIntent { entryKind?: TransactionKind; view?: "trash" | "review" | "organize" }

type NavItem = { page: Page; icon: string };

// A receipt (not in the shared icon set yet).
const RECEIPT_ICON = "M6 2h12v20l-3-2-3 2-3-2-3 2z M9 7h6 M9 11h6 M9 15h4";

// Default Mode: the simple, automation-first navigation.
const NAV: NavItem[] = [
  { page: "dashboard", icon: icons.dashboard },
  { page: "transactions", icon: icons.transactions },
  { page: "categories", icon: icons.tag },
  { page: "import", icon: icons.upload },
  { page: "receipt", icon: RECEIPT_ICON },
  { page: "reports", icon: icons.file },
  { page: "data", icon: icons.data },
  { page: "settings", icon: icons.settings },
];

// Manual Mode: the manual bookkeeping workspace grouped by task, then the automatic tools.
const MANUAL_NAV: Array<{ group: "record" | "organize" | "plan" | "automatic"; items: NavItem[] }> = [
  { group: "record", items: [{ page: "manual", icon: icons.dashboard }, { page: "transactions", icon: icons.transactions }, { page: "receipt", icon: RECEIPT_ICON }] },
  { group: "organize", items: [{ page: "accounts", icon: icons.insights }, { page: "categories", icon: icons.tag }, { page: "lists", icon: icons.file }] },
  { group: "plan", items: [{ page: "planning", icon: icons.forecast }, { page: "reports", icon: icons.file }] },
  { group: "automatic", items: [{ page: "dashboard", icon: icons.dashboard }, { page: "import", icon: icons.upload }, { page: "data", icon: icons.data }, { page: "settings", icon: icons.settings }] },
];

function Icon({ d }: { d: string }) {
  return <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={d} /></svg>;
}

/** The Default / Manual switch. Switching keeps every record and any unfinished form input. */
function ModeSwitch({ mode, onChange }: { mode: Mode; onChange: (mode: Mode) => void }) {
  const { m } = useI18n();
  const x = m.ledger.mode;
  return (
    <div className="bw-mode-switch" role="group" aria-label={x.label}>
      <button type="button" className={mode === "default" ? "bw-mode-option is-active" : "bw-mode-option"} aria-pressed={mode === "default"} title={x.defaultHelp} onClick={() => onChange("default")}>{x.default}</button>
      <button type="button" className={mode === "manual" ? "bw-mode-option is-active is-manual" : "bw-mode-option"} aria-pressed={mode === "manual"} title={x.manualHelp} onClick={() => onChange("manual")}><Icon d={icons.transactions} /><span>{x.manual}</span></button>
    </div>
  );
}

function Shell({ initialPage = "dashboard", initialRoute = null }: { initialPage?: Page; initialRoute?: DeepLinkRoute | null }) {
  const { m } = useI18n();
  const { account } = useAccount();
  const { mode, manual, setMode } = useMode();
  const [page, setPage] = useState<Page>(initialPage);
  const [transactionIntent, setTransactionIntent] = useState<{ key: number; intent: TransactionIntent } | null>(null);
  // A part of a page to bring into view after navigating (e.g. the sync panel on the Data page).
  const [focus, setFocus] = useState<string | null>(null);
  // A filter set by a typed command ("show coffee last month"); `key` remounts the page with it.
  const [transactionFilter, setTransactionFilter] = useState<{ key: number; filter: TransactionFilter } | null>(null);
  const go = (next: Page, part: string | null = null, filter?: TransactionFilter, intent?: TransactionIntent) => {
    setFocus(part);
    setTransactionFilter(filter ? { key: Date.now(), filter } : null);
    setTransactionIntent(intent ? { key: Date.now(), intent } : null);
    if (MANUAL_PAGES.has(next) || intent) setMode("manual");
    setPage(next);
  };
  // Manual opens the manual workspace; Default stays on the page when it exists in Default Mode.
  const switchMode = (next: Mode) => {
    if (next === mode) return;
    setMode(next);
    setTransactionIntent(null);
    if (next === "manual") setPage("manual");
    else if (MANUAL_PAGES.has(page)) setPage("dashboard");
  };
  const { persistent } = useFinance();
  // billieweather:// links and #/capture/… open one screen; they never save or send anything.
  const goRef = useRef(go);
  goRef.current = go;
  useEffect(() => {
    const open = (route: DeepLinkRoute) => {
      if (route === "capture/receipt") goRef.current("receipt");
      else if (route === "capture/expense") goRef.current("transactions", null, undefined, { entryKind: "expense" });
    };
    // A link that arrived while the Welcome page was showing (see Home).
    if (initialRoute) open(initialRoute);
    return subscribeDeepLinks(open);
  }, []); // the initial route is applied once, on mount
  const navLabel = (target: Page) => (target === "manual" ? m.ledger.manual.nav : target === "receipt" ? m.receipt.nav : target === "accounts" || target === "planning" || target === "lists" ? m.ledger.nav[target] : m.nav[target]);
  const navButton = (item: NavItem) => (
    <li key={item.page}>
      <button type="button" className={page === item.page ? "bw-nav-item is-active" : "bw-nav-item"} title={collapsed ? navLabel(item.page) : undefined} aria-current={page === item.page ? "page" : undefined} onClick={() => go(item.page)}>
        <Icon d={item.icon} /><span>{navLabel(item.page)}</span>
      </button>
    </li>
  );
  const [collapsed, setCollapsed] = useState(savedSidebarCollapsed);
  const toggleSidebar = () => setCollapsed((was) => { saveSidebarCollapsed(!was); return !was; });
  return (
    <div className={`bw-app${collapsed ? " is-collapsed" : ""}${manual ? " is-manual-mode" : ""}`} data-mode={mode}>
      <nav className="bw-nav" id="bw-nav" aria-label={m.nav.main}>
        <div className="bw-nav-head">
          <div className="bw-brand"><BrandMark /><span className="bw-brand-name">BillieWeather</span></div>
          <button type="button" className="bw-nav-toggle" aria-controls="bw-nav" aria-expanded={!collapsed} aria-label={collapsed ? m.nav.expand : m.nav.collapse} title={collapsed ? m.nav.expand : m.nav.collapse} onClick={toggleSidebar}>
            <Icon d={icons.collapse} />
          </button>
        </div>
        {manual ? (
          <>
            <p className="bw-mode-badge"><Icon d={icons.transactions} /><span>{m.ledger.mode.manualOn}</span></p>
            {MANUAL_NAV.map(({ group, items }) => (
              <div key={group} className="bw-nav-group">
                <p className="bw-nav-group-label" id={`nav-group-${group}`}>{m.ledger.mode.groups[group]}</p>
                <ul aria-labelledby={`nav-group-${group}`}>{items.map(navButton)}</ul>
              </div>
            ))}
          </>
        ) : <ul>{NAV.map(navButton)}</ul>}
        <div className="bw-nav-bottom">
          <p className="bw-nav-note"><Icon d={icons.lock} /><span>{m.nav.note}</span></p>
          {account && <p className="bw-nav-user"><strong>{account.nickname || account.email}</strong>{account.nickname && <small>{account.email}</small>}</p>}
        </div>
      </nav>
      <main className="bw-main" id="main">
        {!persistent && <p className="bw-preview-banner">{m.preview}</p>}
        <div className="bw-topline"><ModeSwitch mode={mode} onChange={switchMode} /></div>
        <CommandCenter go={go} />
        <SyncStatus />
        <Suspense fallback={<div className="bw-boot" role="status">{m.boot.opening}</div>}>
        {page === "dashboard" && <Dashboard go={go} />}
        {page === "manual" && <Manual go={go} />}
        {page === "transactions" && <Transactions key={`${transactionFilter?.key ?? 0}-${transactionIntent?.key ?? 0}`} preset={transactionFilter?.filter} intent={transactionIntent?.intent} />}
        {page === "accounts" && <Accounts />}
        {page === "categories" && <Categories key={focus ?? ""} focus={focus} />}
        {page === "planning" && <Planning />}
        {page === "lists" && <Lists />}
        {page === "import" && <Import onReceipt={() => go("receipt")} />}
        {page === "receipt" && <Receipt />}
        {page === "reports" && <Reports />}
        {page === "data" && <Data focus={focus} />}
        {page === "settings" && <Settings />}
        </Suspense>
        <footer className="bw-footer">{m.footer}</footer>
      </main>
    </div>
  );
}

/**
 * After sign-in (and naming a new device database): the Welcome page for a newly registered account,
 * otherwise straight to the app. Remounted per account by Gate, so switching accounts re-decides.
 */
function Home() {
  const { account } = useAccount();
  const { ownerKey, transactions, statements } = useFinance();
  // Decided once when the account's book opens; data synced in later does not yank the page away.
  const [welcome, setWelcome] = useState(() => shouldShowWelcome({
    ownerKey, registeredAt: account?.registeredAt ?? null, hasData: transactions.length > 0 || statements.length > 0,
  }));
  const [next, setNext] = useState<{ page: Page; route: DeepLinkRoute | null }>({ page: "dashboard", route: null });
  // A billieweather:// link (Siri, Shortcuts) opens its screen even while the welcome shows. The
  // welcome is not marked finished then, so it can show again next time. Layout effect: a link that
  // launched the app is handled before the first paint, so the welcome does not flash.
  useLayoutEffect(() => {
    if (!welcome) return;
    return subscribeDeepLinks((route) => {
      if (route === "open") return;
      setNext({ page: "dashboard", route });
      setWelcome(false);
    });
  }, [welcome]);
  if (!welcome) return <Shell initialPage={next.page} initialRoute={next.route} />;
  const finish = (page: Page) => {
    if (ownerKey) markWelcomeDone(ownerKey);
    setNext({ page, route: null });
    setWelcome(false);
  };
  return <Welcome name={account?.nickname} onStart={() => finish("import")} onExplore={() => finish("dashboard")} />;
}

function Gate() {
  const { status, account } = useAccount();
  const { m } = useI18n();
  // Which account owns the databases this session may open (review P0-1). A new key remounts the
  // provider, so switching accounts never keeps another account's database open.
  const [keys, setKeys] = useState<{ owner: string; email: string; identity: string } | null>(null);
  const ownerId = account?.ownerId ?? null;
  const email = account?.email ?? null;
  const identity = JSON.stringify([ownerId, email]);
  useEffect(() => {
    if (!email) {
      setKeys(null);
      return;
    }
    let cancelled = false;
    Promise.all([ownerKeyFor({ ownerId, email }), emailOwnerKey(email)]).then(([owner, emailKey]) => { if (!cancelled) setKeys({ owner, email: emailKey, identity }); });
    return () => { cancelled = true; };
  }, [ownerId, email, identity]);
  if (status === "loading") return <div className="bw-boot">{m.boot.opening}</div>;
  if (status === "signedOut") return <SignedOut />;
  if (!keys || keys.identity !== identity) return <div className="bw-boot">{m.boot.opening}</div>;
  return <FinanceProvider key={keys.owner} ownerKey={keys.owner} emailKey={keys.email}><ModeProvider><Home /></ModeProvider></FinanceProvider>;
}

export default function App() {
  return <I18nProvider><AccountProvider><Gate /></AccountProvider></I18nProvider>;
}
