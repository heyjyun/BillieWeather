import type { Currency, MerchantRule, Statement, Transaction } from "@billie/shared-types";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { BackupError } from "../services/backup";
import { AccountError } from "../services/account";
import { declinedSlots, declineSlot, fileForSlot, freeSlot, freeSlots, loadRegistry, MAX_DATABASES, openFailure, ownership, saveRegistry, slotsOfOthers, type Registry } from "../services/databases";
import { focusIsLost } from "./useFocus";
import { deviceName, openDatabase, restoreSnapshot as restoreSnapshotFile } from "../services/platform";
import { queueDelete, reportAll, reportingIdentity, reportingStatus, type ReportingStatus } from "../services/reporting";
import { recordedStore } from "../services/history/recorded";
import { FinanceStore, StoreError, type WebSyncResult } from "../services/store";
import type { Account } from "../services/ledger";
import { syncFromWeb } from "../services/webSync";
import { useAccount } from "./useAccount";
import { useI18n } from "../i18n";
import { NameDatabase } from "../components/NameDatabase";

interface FinanceData {
  transactions: Transaction[];
  /** Every account of this book, archived ones included (services/ledger.ts). */
  accounts: Account[];
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
  /** The signed-in account's owner key (null in tests without an account). */
  ownerKey: string | null;
  /** A free slot for a restored copy (never one listed for another account), or null. */
  claimSlotForRestore: () => Promise<{ id: string; store: FinanceStore } | null>;
  /** Adds a slot that now holds a restored database to this account's list. */
  adoptRestored: (id: string) => Promise<void>;
  /** Opens an automatic pre-migration copy as a new database of this account. Returns its id, or null when no slot is free. */
  openSnapshot: (name: string) => Promise<string | null>;
}

type Opened = { store: FinanceStore; persistent: boolean };

async function readFinance(store: FinanceStore) {
  const [transactions, statements, rules, currency, settings, customCategories, accounts] = await Promise.all([
    store.transactions(), store.statements(), store.rules(), store.currency(),
    store.webSyncSettings(), store.customCategories(), store.ledger.accounts({ includeArchived: true }),
  ]);
  return { data: { transactions, accounts, customCategories, statements, rules, currency }, settings };
}

// When this app session started: the "app last opened" time the website may show.
const APP_OPENED_AT = new Date().toISOString();

const FinanceContext = createContext<FinanceContextValue | null>(null);

/**
 * `ownerKey`: the signed-in account's owner key (services/databases.ts ownerKeyFor); `emailKey` the
 * same account's older email-based key. Every database this provider opens is recorded for, or
 * claimed by, this owner; another account's database is never opened (review P0-1, I-13).
 */
export function FinanceProvider({ children, ownerKey = null, emailKey = null }: { children: ReactNode; ownerKey?: string | null; emailKey?: string | null }) {
  const { m } = useI18n();
  const { getToken, expire, account } = useAccount();
  const accountEmail = account?.email ?? "";
  const aliases = useMemo(() => (emailKey && emailKey !== ownerKey ? [emailKey] : []), [emailKey, ownerKey]);
  const [reporting, setReportingState] = useState<ReportingStatus>(() => reportingStatus(accountEmail));
  const [state, setState] = useState<(Opened & { activeId: string }) | null>(null);
  const [registry, setRegistry] = useState<Registry>(() => loadRegistry(ownerKey, emailKey && emailKey !== ownerKey ? [emailKey] : []));
  const registryRef = useRef(registry);
  // A database from an older version that holds data but has no owner: the person is asked once.
  const [claim, setClaim] = useState<{ id: string } | null>(null);
  // One open handle per database, shared by every page. Keeping the promise (not the result)
  // means two quick calls (React StrictMode, or the Data page and a switch) share one handle.
  const handles = useRef(new Map<string, Promise<Opened>>());
  const commitRegistry = useCallback((next: Registry) => {
    registryRef.current = next;
    saveRegistry(next, ownerKey);
    setRegistry(next);
  }, [ownerKey]);
  const openById = useCallback((id: string): Promise<Opened> => {
    let opened = handles.current.get(id);
    if (!opened) {
      const entry = registryRef.current.entries.find((e) => e.id === id);
      if (!entry) return Promise.reject(new Error("unknown database"));
      opened = openDatabase(entry.file).then(({ driver, persistent }) => ({ store: recordedStore(new FinanceStore(driver)), persistent }));
      handles.current.set(id, opened);
      opened.catch(() => handles.current.delete(id));
    }
    return opened;
  }, []);
  const [data, setData] = useState<FinanceData>({ transactions: [], accounts: [], customCategories: [], statements: [], rules: [], currency: null });
  const [error, setError] = useState<string | null>(null);
  const [errorDetail, setErrorDetail] = useState<string | null>(null);
  // Shows why the local database could not be opened (the plugin's or SQLite's own message).
  const failOpen = useCallback((reason: unknown) => {
    setErrorDetail(reason instanceof Error ? reason.message : String(reason));
    setError("dbError");
  }, []);
  const [sync, setSync] = useState<SyncState>({ status: "idle" });
  const [syncEnabled, setSyncEnabledState] = useState(true);
  const [lastChecked, setLastChecked] = useState<string | null>(null);
  const [databaseName, setDatabaseName] = useState<string | null>(null);
  const activeStore = useRef<FinanceStore | null>(null);
  const activation = useRef(0);
  const refreshSequence = useRef(0);
  const syncing = useRef(new Set<FinanceStore>());

  // Basic facts about the local databases for the website's cards. Never throws, never blocks.
  const reportMetadata = useCallback(async () => {
    try {
      const identity = await reportingIdentity();
      if (!identity) return; // browser preview, QA/debug build or unreadable identity: never reported
      const databases = (await Promise.all(registryRef.current.entries.map(async (entry) => {
        try {
          const opened = await openById(entry.id);
          // Only this account's databases are ever described to this account (I-13).
          if (ownerKey && (await opened.store.owner()) !== ownerKey) return null;
          return opened.persistent ? { id: entry.id, store: opened.store } : null; // in-memory databases are never reported
        } catch {
          return null;
        }
      }))).filter((database): database is { id: string; store: FinanceStore } => database !== null);
      await reportAll({ account: accountEmail, token: getToken(), identity, deviceName: (await deviceName()) ?? "Unknown device", openedAt: APP_OPENED_AT, databases });
    } finally {
      setReportingState(reportingStatus(accountEmail));
    }
  }, [accountEmail, getToken, openById, ownerKey]);

  const publishFinance = useCallback(({ data, settings }: Awaited<ReturnType<typeof readFinance>>) => {
    setData(data);
    setSyncEnabledState(settings.enabled);
    setLastChecked(settings.checkedAt);
  }, []);

  const load = useCallback(async (store: FinanceStore) => {
    if (activeStore.current !== store) return;
    const sequence = ++refreshSequence.current;
    const next = await readFinance(store);
    // A late refresh cannot publish transactions or settings into a different ledger.
    if (activeStore.current === store && refreshSequence.current === sequence) publishFinance(next);
  }, [publishFinance]);

  // Website data is written to the requested ledger even if the person switches during download.
  // The visible status and data belong to the ledger currently in use.
  const runSync = useCallback(async (store: FinanceStore, force = false) => {
    const token = getToken();
    if (!token || syncing.current.has(store)) return;
    syncing.current.add(store);
    const publish = (next: SyncState) => { if (activeStore.current === store) setSync(next); };
    let owned = false;
    try {
      if (ownerKey && (await store.owner()) !== ownerKey) return;
      owned = true;
      publish({ status: "checking" });
      const outcome = await syncFromWeb(store, token, { force });
      publish(outcome.status === "updated" ? { status: "updated", result: outcome.result } : { status: outcome.status });
    } catch (caught) {
      if (caught instanceof AccountError && caught.code === "unauthorized") {
        if (getToken() === token) await expire();
        return;
      }
      if (caught instanceof StoreError && caught.code === "currency_mismatch") {
        publish({ status: "currencyMismatch", web: String(caught.vars.web), device: String(caught.vars.currency) });
      } else {
        publish({ status: caught instanceof AccountError && caught.code === "offline" ? "offline" : "failed" });
      }
    } finally {
      try {
        if (owned) await load(store);
      } catch {
        publish({ status: "failed" });
      } finally {
        syncing.current.delete(store);
      }
    }
  }, [getToken, expire, load, ownerKey]);

  const activate = useCallback(async (id: string, isCancelled: () => boolean = () => false) => {
    const sequence = ++activation.current;
    const { store, persistent } = await openById(id);
    const [next, name] = await Promise.all([readFinance(store), store.databaseName()]);
    if (isCancelled() || activation.current !== sequence) return;
    if (registryRef.current.active !== id) commitRegistry({ ...registryRef.current, active: id });
    activeStore.current = store;
    ++refreshSequence.current;
    publishFinance(next);
    setDatabaseName(name);
    setSync({ status: "idle" });
    setState({ store, persistent, activeId: id });
    // A new database on this device is named first; downloading starts once it has a name.
    if (name || !persistent) void runSync(store);
  }, [openById, commitRegistry, publishFinance, runSync]);

  /** Checks (and records) ownership of one slot for this account. */
  const decide = useCallback(async (id: string): Promise<"use" | "ask" | "skip"> => {
    if (!ownerKey) return "use";
    const { store } = await openById(id);
    const recorded = await store.owner();
    if (recorded === ownerKey) return "use"; // The usual startup does not need a content scan.
    const hasContent = await store.hasContent();
    const verdict = ownership(recorded, ownerKey, emailKey ?? "", hasContent);
    if (verdict === "upgrade" && hasContent) return "ask";
    if (verdict === "mine") return "use";
    if (verdict === "upgrade" || verdict === "claim") {
      await store.setOwner(ownerKey);
      return "use";
    }
    return verdict === "ask" ? "ask" : "skip";
  }, [ownerKey, emailKey, openById]);

  /**
   * The database to open for this account: the one in use if it is theirs, else another of theirs,
   * else a free slot (claimed). Another account's database is dropped from this account's list and
   * left untouched. Returns null while the person is asked about an unowned database with data.
   */
  const resolveDatabase = useCallback(async (skip: ReadonlySet<string> = new Set()): Promise<string | "none" | null> => {
    const current = registryRef.current;
    const ordered = [...current.entries].sort((a, b) => (a.id === current.active ? -1 : b.id === current.active ? 1 : 0));
    const declined = ownerKey ? declinedSlots(ownerKey) : new Set<string>();
    // A database that cannot be OPENED is not another account's: it stays listed, and the
    // error is reported instead of "no free database" (which would hide the real cause).
    let openError: unknown = null;
    const check = (id: string) => decide(id).catch((error: unknown) => {
      openError ??= error;
      return "error" as const;
    });
    for (const entry of ordered) {
      if (declined.has(entry.id) || skip.has(entry.id)) continue;
      const verdict = await check(entry.id);
      // The database in use never gives way to another one silently: the person would think their data was
      // gone or changed. The error says so and offers the others.
      if (verdict === "error" && entry.id === current.active) throw openError;
      if (verdict === "error") continue;
      if (verdict === "use") return entry.id;
      if (verdict === "ask") {
        setClaim({ id: entry.id });
        return null;
      }
      commitRegistry({ entries: registryRef.current.entries.filter((e) => e.id !== entry.id), active: registryRef.current.active === entry.id ? "" : registryRef.current.active });
      handles.current.delete(entry.id);
    }
    // One of this account's own databases could not be opened: report it rather than starting an
    // empty database in its place (the person would think their data was gone).
    if (openError) throw openError;
    // Nothing usable in this account's list: a free slot that no other account lists.
    // (Never instead of one that could not be opened.)
    if (skip.size > 0) return "none";
    const exclude = new Set([...slotsOfOthers(ownerKey, aliases), ...declined]);
    for (const slot of freeSlots(registryRef.current, exclude)) {
      commitRegistry({ entries: [...registryRef.current.entries, slot].sort((a, b) => Number(a.id) - Number(b.id)), active: slot.id });
      const verdict = await check(slot.id);
      if (verdict === "use") return slot.id;
      if (verdict === "ask") {
        setClaim({ id: slot.id });
        return null;
      }
      commitRegistry({ entries: registryRef.current.entries.filter((e) => e.id !== slot.id), active: registryRef.current.active });
      handles.current.delete(slot.id);
    }
    if (openError) throw openError;
    return "none";
  }, [ownerKey, aliases, decide, commitRegistry]);

  const start = useCallback(async (isCancelled: () => boolean, skip?: ReadonlySet<string>) => {
    const id = await resolveDatabase(skip);
    if (isCancelled() || id === null) return;
    if (id === "none") {
      setError("noRoom");
      return;
    }
    await activate(id, isCancelled);
    if (isCancelled()) return;
    // Schedules the person set to post automatically (周期记账) are posted when the book opens.
    const opened = await openById(id);
    if ((await opened.store.ledger.postDue(undefined, { onlyAuto: true }).catch(() => 0)) > 0) await load(opened.store);
    if (!isCancelled()) void reportMetadata(); // the app opened and the person is signed in
  }, [resolveDatabase, activate, openById, load, reportMetadata]);

  useEffect(() => {
    // Open once per sign-in. If React mounts this twice (development StrictMode), both mounts
    // share the same handle for the database in use, so every page reads the store the sync writes to.
    let cancelled = false;
    start(() => cancelled).catch((reason: unknown) => { if (!cancelled) failOpen(reason); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** Tries the same database again (nothing was changed by the failure), or, when asked, opens another one. */
  const reopen = useCallback(async (another: boolean) => {
    const failed = registryRef.current.active;
    setError(null);
    setErrorDetail(null);
    await start(() => false, another ? new Set([failed]) : undefined).catch(failOpen);
  }, [start, failOpen]);

  const answerClaim = useCallback(async (mine: boolean) => {
    if (!claim || !ownerKey) return;
    const { id } = claim;
    setClaim(null);
    if (mine) {
      await (await openById(id)).store.setOwner(ownerKey);
      if (!registryRef.current.entries.some((e) => e.id === id)) commitRegistry({ entries: [...registryRef.current.entries, { id, file: fileForSlot(Number(id)) }], active: id });
      else commitRegistry({ ...registryRef.current, active: id });
    } else {
      declineSlot(ownerKey, id);
      commitRegistry({ entries: registryRef.current.entries.filter((e) => e.id !== id), active: registryRef.current.active === id ? "" : registryRef.current.active });
      handles.current.delete(id);
    }
    await start(() => false).catch(failOpen);
  }, [claim, ownerKey, openById, commitRegistry, start, failOpen]);

  const value = useMemo<FinanceContextValue | null>(
    () => state ? {
      ...data, ...state, sync, syncEnabled, lastChecked,
      // Called after a change was saved. If the book cannot be read back, saying so is the truth; reporting
      // the saved change as failed would invite saving it twice.
      refresh: () => load(state.store).catch((reason: unknown) => { if (activeStore.current === state.store) failOpen(reason); }),
      syncNow: async (force = true) => {
        await runSync(state.store, force);
        void reportMetadata();
      },
      reporting,
      reportNow: reportMetadata,
      setSyncEnabled: async (enabled: boolean) => {
        await state.store.setWebSyncEnabled(enabled);
        if (activeStore.current === state.store) {
          setSyncEnabledState(enabled);
          setSync({ status: enabled ? "idle" : "disabled" });
        }
        if (enabled) await runSync(state.store, true);
      },
      databaseName,
      renameDatabase: async (name: string) => {
        const stored = await state.store.setDatabaseName(name);
        if (activeStore.current === state.store) setDatabaseName(stored);
        void reportMetadata();
      },
      renameDatabaseById: async (id: string, name: string) => {
        const { store } = await openById(id);
        const stored = await store.setDatabaseName(name);
        if (activeStore.current === store) setDatabaseName(stored);
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
        const exclude = new Set([...slotsOfOthers(ownerKey, aliases), ...(ownerKey ? declinedSlots(ownerKey) : [])]);
        for (;;) {
          const slot = freeSlot(registryRef.current, exclude);
          if (!slot || !state.persistent) throw new StoreError("invalid_name", "No room for another database.");
          commitRegistry({ ...registryRef.current, entries: [...registryRef.current.entries, slot] });
          try {
            const { store } = await openById(slot.id);
            // A slot missing from the list but holding data is a database whose list entry was
            // lost (cleared app storage): keep it listed and never wipe it; try the next slot.
            if (await store.hasContent()) {
              // A database whose list entry was lost (cleared app storage): never wiped. It stays
              // listed when it is this account's or has no owner yet; another account's is skipped.
              const recorded = await store.owner();
              if (ownerKey && recorded !== null && recorded !== ownerKey && recorded !== emailKey) {
                exclude.add(slot.id);
                commitRegistry({ ...registryRef.current, entries: registryRef.current.entries.filter((e) => e.id !== slot.id) });
                handles.current.delete(slot.id);
              }
              continue;
            }
            await store.deleteAllData({ forgetName: true }); // leftovers of a removed database
            if (ownerKey) await store.setOwner(ownerKey);
            await store.setDatabaseName(name);
            void reportMetadata();
          } catch (error) {
            handles.current.delete(slot.id);
            commitRegistry({ ...registryRef.current, entries: registryRef.current.entries.filter((e) => e.id !== slot.id) });
            throw error;
          }
          return slot.id;
        }
      },
      ownerKey,
      claimSlotForRestore: async () => {
        if (!state.persistent) return null;
        const exclude = new Set([...slotsOfOthers(ownerKey, aliases), ...(ownerKey ? declinedSlots(ownerKey) : [])]);
        for (const slot of freeSlots(registryRef.current, exclude)) {
          // Opened outside the list first; it joins the list only once the restore is verified.
          const opened = await openDatabase(slot.file).then(({ driver }) => recordedStore(new FinanceStore(driver)));
          if (await opened.hasContent()) continue;
          handles.current.set(slot.id, Promise.resolve({ store: opened, persistent: true }));
          return { id: slot.id, store: opened };
        }
        return null;
      },
      adoptRestored: async (id: string) => {
        if (!registryRef.current.entries.some((e) => e.id === id)) commitRegistry({ ...registryRef.current, entries: [...registryRef.current.entries, { id, file: fileForSlot(Number(id)) }].sort((a, b) => Number(a.id) - Number(b.id)) });
        void reportMetadata();
      },
      openSnapshot: async (name: string) => {
        const exclude = new Set([...slotsOfOthers(ownerKey, aliases), ...(ownerKey ? declinedSlots(ownerKey) : [])]);
        for (const slot of freeSlots(registryRef.current, exclude)) {
          if (handles.current.has(slot.id)) continue;
          try {
            await restoreSnapshotFile(name, Number(slot.id));
          } catch {
            continue; // that slot's file exists; try the next one
          }
          // Snapshot names identify slots, not owners. A slot may have been reused by another
          // account since the copy was made: check the copied file before listing or reporting it.
          const opened = await openDatabase(slot.file);
          const store = recordedStore(new FinanceStore(opened.driver));
          const recorded = await store.owner();
          if (ownerKey && recorded && recorded !== ownerKey && recorded !== emailKey) {
            // Only this just-created disposable copy is cleared; its source snapshot is untouched.
            // Without an owner the emptied file is free again for a new database or a restore.
            await store.deleteAllData({ forgetName: true });
            await store.sql.execute("DELETE FROM settings WHERE key = 'owner_account_id'");
            throw new BackupError("other_account", "This snapshot belongs to another account.");
          }
          await store.sql.execute("DELETE FROM settings WHERE key IN ('report_id', 'web_sync_version', 'web_sync_checked_at', 'last_synced_at', 'web_sync_skip')");
          if (ownerKey) await store.setOwner(ownerKey);
          const name0 = await store.databaseName();
          await store.setDatabaseName(`${name0 ?? "BillieWeather"} (${new Date().toISOString().slice(0, 10)})`);
          handles.current.set(slot.id, Promise.resolve({ store, persistent: opened.persistent }));
          commitRegistry({ ...registryRef.current, entries: [...registryRef.current.entries, slot].sort((a, b) => Number(a.id) - Number(b.id)) });
          void reportMetadata();
          return slot.id;
        }
        return null;
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
    [data, state, registry, sync, syncEnabled, lastChecked, databaseName, reporting, reportMetadata, load, runSync, activate, openById, commitRegistry, failOpen, ownerKey, emailKey, aliases],
  );

  if (claim) {
    return (
      <div className="bw-boot bw-claim" role="dialog" aria-labelledby="bw-claim-title">
        <h1 id="bw-claim-title" tabIndex={-1} ref={(element) => { if (element && focusIsLost()) element.focus(); }}>{m.ledger.owner.claimTitle}</h1>
        <p>{m.ledger.owner.claimBody}</p>
        <div className="bw-actions">
          <button type="button" className="bw-button" onClick={() => void answerClaim(true)}>{m.ledger.owner.claimMine}</button>
          <button type="button" className="bw-button bw-button-outline" onClick={() => void answerClaim(false)}>{m.ledger.owner.claimNotMine}</button>
        </div>
      </div>
    );
  }
  if (error === "noRoom") return <div className="bw-boot" role="alert">{m.ledger.owner.noRoom}</div>;
  if (error) {
    return (
      <div className="bw-boot" role="alert">
        <p>{m.boot.dbError}</p>
        <p>{m.boot.failure[openFailure(errorDetail ?? "")]}</p>
        {errorDetail ? <small>{errorDetail}</small> : null}
        <div className="bw-actions">
          <button type="button" className="bw-button" onClick={() => void reopen(false)}>{m.connection.retry}</button>
          {registry.entries.length > 1 && <button type="button" className="bw-button bw-button-outline" onClick={() => void reopen(true)}>{m.boot.openAnother}</button>}
        </div>
      </div>
    );
  }
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
