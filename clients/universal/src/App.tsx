import type { QuickEntry } from "./services/quickEntry";
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
import { ConnectionStatus } from "./components/ConnectionStatus";
import { HistoryControls } from "./components/HistoryControls";
import { CommandCenter } from "./components/CommandCenter";
import type { TransactionFilter } from "./commands/handlers";
import type { TransactionKind } from "@billie/shared-types";
import { saveSidebarCollapsed, savedSidebarCollapsed } from "./services/theme";
import { subscribeDeepLinks, type DeepLinkRoute } from "./services/deepLink";
import { markWelcomeDone, shouldShowWelcome } from "./services/onboarding";
import { Welcome } from "./pages/Welcome";
import { BrandMark } from "./components/BrandMark";
import { ModuleUnavailable } from "./components/ModuleUnavailable";
import { ModuleIcon } from "./components/ModuleIcon";
import { ModulesProvider, useModules } from "./hooks/useModules";
import { moduleById, type ModuleDefinition, type ModuleId } from "@billie/shared-types";

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
const FeatureLibrary = lazy(() => import("./pages/FeatureLibrary").then((module) => ({ default: module.FeatureLibrary })));
const AddSync = lazy(() => import("./pages/AddSync").then((module) => ({ default: module.AddSync })));
const Assistant = lazy(() => import("./pages/Assistant").then((module) => ({ default: module.Assistant })));

export type Page = "dashboard" | "manual" | "transactions" | "accounts" | "categories" | "planning" | "lists" | "import" | "receipt" | "reports" | "data" | "settings" | "features" | "addSync" | "assistant";

/**
 * Which Feature Library module each page belongs to (packages/shared-types/schema/module-catalog.json).
 * A page opens when one of its modules is usable in the app (available), whatever the sidebar shows; the
 * sidebar is navigation only. Settings and the Feature Library itself are system pages and always open.
 */
export const PAGE_MODULES: Record<Page, readonly ModuleId[]> = {
  dashboard: ["overview"], transactions: ["transactions"], manual: ["transactions"], import: ["import"], receipt: ["receipts"], addSync: ["transactions"],
  assistant: ["ai_assistant"], accounts: ["accounts"], categories: ["categories"], lists: ["categories"], planning: ["budgets", "recurring"], reports: ["reports"],
  data: ["data_management"], settings: [], features: [],
};

/** Transactions › Overview / All Transactions / Add & Sync, and the pages under each. */
const TRANSACTION_SECTIONS: Array<{ key: "overview" | "allTransactions" | "addSync"; page: Page; pages: Page[] }> = [
  { key: "overview", page: "dashboard", pages: ["dashboard"] },
  { key: "allTransactions", page: "transactions", pages: ["transactions"] },
  { key: "addSync", page: "addSync", pages: ["addSync", "import", "receipt", "manual"] },
];
const ADD_SYNC_TABS: Array<{ key: "import" | "receipt" | "manual"; page: Page }> = [{ key: "import", page: "import" }, { key: "receipt", page: "receipt" }, { key: "manual", page: "manual" }];

/** What to open on the Transactions page: a new entry of a kind, or the trash / review list. */
export interface TransactionIntent { entryKind?: TransactionKind; entryDraft?: QuickEntry; view?: "trash" | "review" | "organize" }

function Icon({ d }: { d: string }) {
  return <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={d} /></svg>;
}

/** The accounting mode switch. Switching keeps every record and any unfinished form input. */
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
  const modules = useModules();
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
    setPage(next);
  };
  const pageOpen = (target: Page) => PAGE_MODULES[target].length === 0 || PAGE_MODULES[target].some((id) => modules.usable(id));
  // The module whose page this is, when none of its modules is built for the app (a guard: today every mapped module is).
  const blocked: ModuleDefinition | null = pageOpen(page) ? null : moduleById(PAGE_MODULES[page][0]) ?? null;
  const openModule = (module: ModuleDefinition) => {
    const target = module.destination.app as Page | null;
    if (target) go(target, module.id === "recurring" ? "schedules" : null);
  };
  // Budgets and Recurring & Bills both live on the Planning page; the highlighted one follows the section opened.
  const moduleActive = (module: ModuleDefinition) => {
    if (module.id === "transactions" && section && PAGE_MODULES[page].every((id) => !modules.inSidebar(id))) return true;
    if (!PAGE_MODULES[page].includes(module.id)) return false;
    if (page !== "planning") return true;
    const both = modules.inSidebar("budgets") && modules.inSidebar("recurring");
    return !both || (module.id === "recurring") === (focus === "schedules");
  };
  const settingsActive = page === "settings" || page === "features" || (page === "data" && !modules.inSidebar("data_management"));
  const section = blocked ? null : TRANSACTION_SECTIONS.find((item) => item.pages.includes(page)) ?? null;
  // A module opened while it is not in the sidebar (from Settings or the Feature Library): nothing in the
  // sidebar is highlighted, so say where this is and lead back. The sidebar itself is never changed.
  // Pages under Transactions keep their section tabs instead.
  const offSidebar: ModuleDefinition | null = blocked || section || PAGE_MODULES[page].length === 0 || PAGE_MODULES[page].some((id) => modules.inSidebar(id)) ? null
    : moduleById(page === "planning" && focus === "schedules" ? "recurring" : PAGE_MODULES[page][0]) ?? null;
  const { persistent } = useFinance();
  // billieweather:// links and #/capture/… open one screen; they never save or send anything.
  const goRef = useRef(go);
  useEffect(() => {
    function quickEntry(event: KeyboardEvent) {
      if (event.repeat || event.isComposing || event.altKey || !(event.metaKey || event.ctrlKey) || !event.shiftKey || event.key.toLowerCase() !== "e") return;
      event.preventDefault();
      goRef.current("transactions", null, undefined, { entryKind: "expense" });
    }
    window.addEventListener("keydown", quickEntry);
    return () => window.removeEventListener("keydown", quickEntry);
  }, []);
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
  const moduleButton = (module: ModuleDefinition) => {
    const label = m.modules.names[module.id];
    const active = moduleActive(module) && !settingsActive;
    return (
      <li key={module.id}>
        <button type="button" className={active ? "bw-nav-item is-active" : "bw-nav-item"} title={collapsed ? label : undefined} aria-current={active ? "page" : undefined} data-module={module.id} onClick={() => openModule(module)}>
          <ModuleIcon name={module.icon} /><span>{label}</span>
        </button>
      </li>
    );
  };
  const [collapsed, setCollapsed] = useState(savedSidebarCollapsed);
  const toggleSidebar = () => setCollapsed((was) => { saveSidebarCollapsed(!was); return !was; });
  return (
    <div className={`bw-app${collapsed ? " is-collapsed" : ""}${manual ? " is-manual-mode" : ""}`} data-mode={mode}>
      <button type="button" className="bw-skip" onClick={() => document.getElementById("main")?.focus()}>{m.nav.skip}</button>
      <nav className="bw-nav" id="bw-nav" aria-label={m.nav.main}>
        <div className="bw-nav-head">
          <div className="bw-brand"><BrandMark /><span className="bw-brand-name">BillieWeather</span></div>
          <button type="button" className="bw-nav-toggle" aria-controls="bw-nav" aria-expanded={!collapsed} aria-label={collapsed ? m.nav.expand : m.nav.collapse} title={collapsed ? m.nav.expand : m.nav.collapse} onClick={toggleSidebar}>
            <Icon d={icons.collapse} />
          </button>
        </div>
        {/* Sidebar: the modules the person shows (Feature Library), then Settings (always). The same in both modes.
            Modules not listed here still work; they open from Settings and the Feature Library. */}
        <ul id="module-nav">{modules.sidebarList.map(moduleButton)}</ul>
        <ul className="bw-system-nav">
          <li>
            <button type="button" className={settingsActive ? "bw-nav-item is-active" : "bw-nav-item"} title={collapsed ? m.modules.nav.settings : undefined} aria-current={settingsActive ? "page" : undefined} onClick={() => go("settings")}>
              <Icon d={icons.settings} /><span>{m.modules.nav.settings}</span>
            </button>
          </li>
        </ul>
        <div className="bw-nav-bottom">
          <button type="button" className="bw-nav-item bw-account-shortcut" title={collapsed ? m.modules.library.account : undefined} onClick={() => go("settings", "account")}>
            <ModuleIcon name="users" /><span>{m.modules.library.account}</span>
          </button>
          {account && <p className="bw-nav-user"><strong>{account.nickname || account.email}</strong>{account.nickname && <small>{account.email}</small>}</p>}
        </div>
      </nav>
      <main className="bw-main" id="main" tabIndex={-1}>
        {!persistent && <p className="bw-preview-banner">{m.preview}</p>}
        <div className="bw-topline"><HistoryControls /><ModeSwitch mode={mode} onChange={setMode} />{manual && <span className="bw-sr-only" id="manual-mode-badge">{m.ledger.mode.manualOn}</span>}</div>
        <CommandCenter go={go} />
        <ConnectionStatus />
        <SyncStatus />
        <Suspense fallback={<div className="bw-boot" role="status">{m.boot.opening}</div>}>
        {section && (
          <div className="bw-section-tabs" id="transactions-tabs">
            <div className="bw-tabs" role="group" aria-label={m.modules.nav.sections}>
              {TRANSACTION_SECTIONS.map((item) => (
                <button key={item.key} type="button" className={section.key === item.key ? "bw-tab is-active" : "bw-tab"} aria-current={section.key === item.key ? "page" : undefined} onClick={() => go(item.page)}>{m.modules.sections[item.key]}</button>
              ))}
            </div>
            {section.key === "addSync" && (
              <div className="bw-subtabs" role="group" aria-label={m.modules.sections.addSync}>
                {ADD_SYNC_TABS.map((item) => (
                  <button key={item.key} type="button" className={page === item.page ? "bw-subtab is-active" : "bw-subtab"} aria-current={page === item.page ? "page" : undefined} onClick={() => go(item.page)}>{m.modules.sections[item.key]}</button>
                ))}
              </div>
            )}
          </div>
        )}
        {!blocked && PAGE_MODULES[page][0] === "categories" && (
          <div className="bw-section-tabs" id="module-tabs">
            <div className="bw-tabs" role="group" aria-label={m.modules.names.categories}>
              {(["categories", "lists"] as const).map((target) => (
                <button key={target} type="button" className={page === target ? "bw-tab is-active" : "bw-tab"} aria-current={page === target ? "page" : undefined} onClick={() => go(target)}>{target === "categories" ? m.nav.categories : m.ledger.nav.lists}</button>
              ))}
            </div>
          </div>
        )}
        {offSidebar && (
          <p className="bw-page-context" id="page-context" data-module={offSidebar.id}>
            <button type="button" className="bw-link-button" onClick={() => go("settings")}>{m.modules.nav.settings}</button>
            <span aria-hidden="true">/</span><strong>{m.modules.names[offSidebar.id]}</strong>
            <span className="bw-caption">{m.modules.library.hiddenStillWorks}</span>
          </p>
        )}
        {blocked ? <ModuleUnavailable module={blocked} openLibrary={() => go("features")} /> : (
        <>
        {page === "dashboard" && <Dashboard go={go} />}
        {page === "manual" && <Manual go={go} />}
        {page === "transactions" && <Transactions key={`${transactionFilter?.key ?? 0}-${transactionIntent?.key ?? 0}`} preset={transactionFilter?.filter} intent={transactionIntent?.intent} />}
        {page === "accounts" && <Accounts />}
        {page === "categories" && <Categories key={focus ?? ""} focus={focus} />}
        {page === "planning" && <Planning key={focus ?? ""} focus={focus} />}
        {page === "lists" && <Lists />}
        {page === "import" && <Import onReceipt={() => go("receipt")} />}
        {page === "receipt" && <Receipt />}
        {page === "reports" && <Reports />}
        {page === "data" && <Data focus={focus} />}
        {page === "settings" && <Settings go={go} openModule={openModule} focus={focus} />}
        {page === "features" && <FeatureLibrary open={openModule} />}
        {page === "addSync" && <AddSync openImport={() => go("import")} openReceipt={() => go("receipt")} openEntry={(entryDraft) => go("transactions", null, undefined, { entryKind: entryDraft?.kind ?? "expense", entryDraft })} openManual={() => go("manual")} />}
        {page === "assistant" && <Assistant />}
        </>
        )}
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
  const { status, account, getToken, offline } = useAccount();
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
  return <FinanceProvider key={keys.owner} ownerKey={keys.owner} emailKey={keys.email}><ModulesProvider key={keys.owner} ownerKey={keys.owner} accountId={ownerId} getToken={getToken} offline={offline}><ModeProvider><Home /></ModeProvider></ModulesProvider></FinanceProvider>;
}

export default function App() {
  return <I18nProvider><AccountProvider><Gate /></AccountProvider></I18nProvider>;
}
