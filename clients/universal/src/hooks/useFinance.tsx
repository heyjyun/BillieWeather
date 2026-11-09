import type { Currency, MerchantRule, Statement, Transaction } from "@billie/shared-types";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { AccountError } from "../services/account";
import { openDatabase } from "../services/platform";
import { FinanceStore, StoreError, type WebSyncResult } from "../services/store";
import { syncFromWeb } from "../services/webSync";
import { useAccount } from "./useAccount";
import { useI18n } from "../i18n";

interface FinanceData {
  transactions: Transaction[];
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
}

const FinanceContext = createContext<FinanceContextValue | null>(null);

export function FinanceProvider({ children }: { children: ReactNode }) {
  const { m } = useI18n();
  const { getToken, expire } = useAccount();
  const [state, setState] = useState<{ store: FinanceStore; persistent: boolean } | null>(null);
  const [data, setData] = useState<FinanceData>({ transactions: [], statements: [], rules: [], currency: null });
  const [error, setError] = useState<string | null>(null);
  const [sync, setSync] = useState<SyncState>({ status: "idle" });
  const [syncEnabled, setSyncEnabledState] = useState(true);
  const [lastChecked, setLastChecked] = useState<string | null>(null);
  const syncing = useRef(false);

  const load = useCallback(async (store: FinanceStore) => {
    const [transactions, statements, rules, currency, settings] = await Promise.all([store.transactions(), store.statements(), store.rules(), store.currency(), store.webSyncSettings()]);
    setData({ transactions, statements, rules, currency });
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

  useEffect(() => {
    openDatabase()
      .then(async ({ driver, persistent }) => {
        const store = new FinanceStore(driver);
        await load(store);
        setState({ store, persistent });
        void runSync(store);
      })
      .catch(() => setError("dbError"));
    // Open once per sign-in.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const value = useMemo<FinanceContextValue | null>(
    () => state ? {
      ...data, ...state, sync, syncEnabled, lastChecked,
      refresh: () => load(state.store),
      syncNow: (force = true) => runSync(state.store, force),
      setSyncEnabled: async (enabled: boolean) => {
        await state.store.setWebSyncEnabled(enabled);
        setSyncEnabledState(enabled);
        setSync({ status: enabled ? "idle" : "disabled" });
        if (enabled) await runSync(state.store, true);
      },
    } : null,
    [data, state, sync, syncEnabled, lastChecked, load, runSync],
  );

  if (error) return <div className="bw-boot" role="alert">{m.boot.dbError}</div>;
  if (!value) return <div className="bw-boot">{m.boot.opening}</div>;
  return <FinanceContext.Provider value={value}>{children}</FinanceContext.Provider>;
}

export function useFinance(): FinanceContextValue {
  const value = useContext(FinanceContext);
  if (!value) throw new Error("useFinance must be used inside FinanceProvider");
  return value;
}
