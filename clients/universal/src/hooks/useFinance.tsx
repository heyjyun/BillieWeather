import type { Currency, MerchantRule, Statement, Transaction } from "@billie/shared-types";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { AccountError } from "../services/account";
import { freeSlot, loadRegistry, MAX_DATABASES, saveRegistry, type Registry } from "../services/databases";
import { deviceName, openDatabase } from "../services/platform";
import { queueDelete, reportAll, reportingStatus, type ReportingStatus } from "../services/reporting";
import { FinanceStore, StoreError, type WebSyncResult } from "../services/store";
import { syncFromWeb } from "../services/webSync";
import { useAccount } from "./useAccount";
import { useI18n } from "../i18n";
import { NameDatabase } from "../components/NameDatabase";

interface FinanceData {
  transactions: Transaction[];
  /** The person's own categories in this database (built-in ones are in CATEGORIES). */
  customCategories: string[];
  statements: Statement[];
  rules: MerchantRule[];
  currency: Currency | null;
}

export type SyncState =
  | { status: "idle" | "checking" | "disabled" | "upToDate" | "offline" | "failed" }
  | { status: "updated"; result: WebSyncResult }
  | { status: "currencyMismatch"; web: string; device: string };

interface FinanceContextValue extends FinanceData {
  store: FinanceStore;
  persistent: boolean;
  refresh: () => Promise<void>;
  sync: SyncState;
  syncEnabled: boolean;
  lastChecked: string | null;
  syncNow: (force?: boolean) => Promise<void>;
  setSyncEnabled: (enabled: boolean) => Promise<void>;
  /** The person's name for this device's database (null in the unsaved browser preview). */
  databaseName: string | null;
  renameDatabase: (name: string) => Promise<void>;
  /** Every database on this device (slot ids), which one is in use, and the most a device can hold. */
  databaseIds: string[];
  activeDatabaseId: string;
  maxDatabases: number;
  /** Opens (once) any database on this device, for the Data page's overview and transfers. */
  openStore: (id: string) => Promise<FinanceStore>;
  switchDatabase: (id: string) => Promise<void>;
  renameDatabaseById: (id: string, name: string) => Promise<void>;
  /** Basic facts about the local databases are always shown on the website; see services/reporting.ts. */
  reporting: ReportingStatus;
  /** Tells the website about this device's databases now (metadata only). */
  reportNow: () => Promise<void>;
  /** Creates a new, named, empty database and returns its id. Does not switch to it. */
  createDatabase: (name: string) => Promise<string>;
  /** Empties a database for good. With more than one, the database itself is removed from the list. */
  removeDatabase: (id: string) => Promise<void>;
}

type Opened = { store: FinanceStore; persistent: boolean };

// When this app session started: the "app last opened" time the website may show.
const APP_OPENED_AT = new Date().toISOString();

const FinanceContext = createContext<FinanceContextValue | null>(null);

export function FinanceProvider({ children }: { children: ReactNode }) {
  const { m } = useI18n();
  const { getToken, expire, account } = useAccount();
  const accountEmail = account?.email ?? "";
  const [reporting, setReportingState] = useState<ReportingStatus>(() => reportingStatus(accountEmail));
  const [state, setState] = useState<(Opened & { activeId: string }) | null>(null);
  const [registry, setRegistry] = useState<Registry>(() => loadRegistry());
  const registryRef = useRef(registry);
  // One open handle per database, shared by every page. Keeping the promise (not the result)
  // means two quick calls (React StrictMode, or the Data page and a switch) share one handle.
  const handles = useRef(new Map<string, Promise<Opened>>());
  const commitRegistry = useCallback((next: Registry) => {
    registryRef.current = next;
    saveRegistry(next);
    setRegistry(next);
  }, []);
  const openById = useCallback((id: string): Promise<Opened> => {
    let opened = handles.current.get(id);
    if (!opened) {
      const entry = registryRef.current.entries.find((e) => e.id === id);
      if (!entry) return Promise.reject(new Error("unknown database"));
      opened = openDatabase(entry.file).then(({ driver, persistent }) => ({ store: new FinanceStore(driver), persistent }));
      handles.current.set(id, opened);
      opened.catch(() => handles.current.delete(id));
    }
    return opened;
  }, []);
  const [data, setData] = useState<FinanceData>({ transactions: [], customCategories: [], statements: [], rules: [], currency: null });
  const [error, setError] = useState<string | null>(null);
  const [sync, setSync] = useState<SyncState>({ status: "idle" });
  const [syncEnabled, setSyncEnabledState] = useState(true);
  const [lastChecked, setLastChecked] = useState<string | null>(null);
  const [databaseName, setDatabaseName] = useState<string | null>(null);
  const syncing = useRef(false);

  // Basic facts about the local databases for the website's cards. Never throws, never blocks.
  const reportMetadata = useCallback(async () => {
    try {
      const databases = (await Promise.all(registryRef.current.entries.map(async (entry) => {
        try {
          return { id: entry.id, store: (await openById(entry.id)).store };
        } catch {
          return null;
        }
      }))).filter((database): database is { id: string; store: FinanceStore } => database !== null);
      await reportAll({ account: accountEmail, token: getToken(), deviceName: (await deviceName()) ?? "Unknown device", openedAt: APP_OPENED_AT, databases });
    } finally {
      setReportingState(reportingStatus(accountEmail));
    }
  }, [accountEmail, getToken, openById]);

  const load = useCallback(async (store: FinanceStore) => {
    const [transactions, statements, rules, currency, settings, customCategories] = await Promise.all([store.transactions(), store.statements(), store.rules(), store.currency(), store.webSyncSettings(), store.customCategories()]);
    setData({ transactions, customCategories, statements, rules, currency });
    setSyncEnabledState(settings.enabled);
    setLastChecked(settings.checkedAt);
  }, []);

  // Download changes from the website, if any. Runs on every sign-in and app start.
  const runSync = useCallback(async (store: FinanceStore, force = false) => {
    const token = getToken();
    if (!token || syncing.current) return;
    syncing.current = true;
    setSync({ status: "checking" });
    try {
      const outcome = await syncFromWeb(store, token, { force });
      setSync(outcome.status === "updated" ? { status: "updated", result: outcome.result } : { status: outcome.status });
    } catch (caught) {
      if (caught instanceof AccountError && caught.code === "unauthorized") {
        await expire();
        return;
      }
      if (caught instanceof StoreError && caught.code === "currency_mismatch") {
        setSync({ status: "currencyMismatch", web: String(caught.vars.web), device: String(caught.vars.currency) });
      } else {
        setSync({ status: caught instanceof AccountError && caught.code === "offline" ? "offline" : "failed" });
      }
    } finally {
      syncing.current = false;
      await load(store);
    }
  }, [getToken, expire, load]);

  // Makes one database the one every page reads, and downloads website changes into it.
  const activate = useCallback(async (id: string, isCancelled: () => boolean = () => false) => {
    const { store, persistent } = await openById(id);
    await load(store);
    const name = await store.databaseName();
    if (isCancelled()) return;
    if (registryRef.current.active !== id) commitRegistry({ ...registryRef.current, active: id });
    setDatabaseName(name);
    setSync({ status: "idle" });
    setState({ store, persistent, activeId: id });
    // A new database on this device is named first; downloading starts once it has a name.
    if (name || !persistent) void runSync(store);
  }, [openById, load, commitRegistry, runSync]);

  useEffect(() => {
    // Open once per sign-in. If React mounts this twice (development StrictMode), both mounts
    // share the same handle for the database in use, so every page reads the store the sync writes to.
    let cancelled = false;
    activate(registryRef.current.active, () => cancelled)
      .then(() => { if (!cancelled) void reportMetadata(); }) // the app opened and the person is signed in
      .catch(() => { if (!cancelled) setError("dbError"); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const value = useMemo<FinanceContextValue | null>(
    () => state ? {
      ...data, ...state, sync, syncEnabled, lastChecked,
      refresh: () => load(state.store),
      syncNow: async (force = true) => {
        await runSync(state.store, force);
        void reportMetadata();
      },
      reporting,
      reportNow: reportMetadata,
      setSyncEnabled: async (enabled: boolean) => {
        await state.store.setWebSyncEnabled(enabled);
        setSyncEnabledState(enabled);
        setSync({ status: enabled ? "idle" : "disabled" });
        if (enabled) await runSync(state.store, true);
      },
      databaseName,
      renameDatabase: async (name: string) => {
        setDatabaseName(await state.store.setDatabaseName(name));
        void reportMetadata();
      },
      renameDatabaseById: async (id: string, name: string) => {
        const { store } = await openById(id);
        const stored = await store.setDatabaseName(name);
        if (id === state.activeId) setDatabaseName(stored);
        void reportMetadata();
      },
      databaseIds: registry.entries.map((e) => e.id),
      activeDatabaseId: state.activeId,
      maxDatabases: MAX_DATABASES,
      openStore: async (id: string) => (await openById(id)).store,
      switchDatabase: async (id: string) => {
        if (id !== state.activeId) await activate(id);
      },
      createDatabase: async (name: string) => {
        const slot = freeSlot(registryRef.current);
        if (!slot || !state.persistent) throw new StoreError("invalid_name", "No room for another database.");
        commitRegistry({ ...registryRef.current, entries: [...registryRef.current.entries, slot] });
        try {
          const { store } = await openById(slot.id);
          await store.deleteAllData({ forgetName: true }); // a reused slot always starts empty
          await store.setDatabaseName(name);
          void reportMetadata();
        } catch (error) {
          handles.current.delete(slot.id);
          commitRegistry({ ...registryRef.current, entries: registryRef.current.entries.filter((e) => e.id !== slot.id) });
          throw error;
        }
        return slot.id;
      },
      removeDatabase: async (id: string) => {
        const { store } = await openById(id);
        const only = registryRef.current.entries.length === 1;
        const reportedAs = await store.peekReportId(); // wiping forgets it, so read it first
        await store.deleteAllData({ forgetName: !only });
        queueDelete(accountEmail, reportedAs);
        void reportMetadata();
        if (only) {
          if (id === state.activeId) await load(store);
          return;
        }
        const remaining = registryRef.current.entries.filter((e) => e.id !== id);
        commitRegistry({ ...registryRef.current, entries: remaining, active: id === state.activeId ? remaining[0].id : state.activeId });
        handles.current.delete(id);
        if (id === state.activeId) await activate(remaining[0].id);
      },
    } : null,
    [data, state, registry, sync, syncEnabled, lastChecked, databaseName, reporting, reportMetadata, load, runSync, activate, openById, commitRegistry],
  );

  if (error) return <div className="bw-boot" role="alert">{m.boot.dbError}</div>;
  if (!value) return <div className="bw-boot">{m.boot.opening}</div>;
  if (value.persistent && !databaseName) {
    return (
      <NameDatabase
        onSave={async (name) => {
          setDatabaseName(await value.store.setDatabaseName(name));
          void runSync(value.store);
        }}
      />
    );
  }
  return <FinanceContext.Provider value={value}>{children}</FinanceContext.Provider>;
}

export function useFinance(): FinanceContextValue {
  const value = useContext(FinanceContext);
  if (!value) throw new Error("useFinance must be used inside FinanceProvider");
  return value;
}
