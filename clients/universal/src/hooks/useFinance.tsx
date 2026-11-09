import type { Currency, MerchantRule, Statement, Transaction } from "@billie/shared-types";
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { openDatabase } from "../services/platform";
import { FinanceStore } from "../services/store";
import { useI18n } from "../i18n";

interface FinanceData {
  transactions: Transaction[];
  statements: Statement[];
  rules: MerchantRule[];
  currency: Currency | null;
}

interface FinanceContextValue extends FinanceData {
  store: FinanceStore;
  persistent: boolean;
  refresh: () => Promise<void>;
}

const FinanceContext = createContext<FinanceContextValue | null>(null);

export function FinanceProvider({ children }: { children: ReactNode }) {
  const { m } = useI18n();
  const [state, setState] = useState<{ store: FinanceStore; persistent: boolean } | null>(null);
  const [data, setData] = useState<FinanceData>({ transactions: [], statements: [], rules: [], currency: null });
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (store: FinanceStore) => {
    const [transactions, statements, rules, currency] = await Promise.all([store.transactions(), store.statements(), store.rules(), store.currency()]);
    setData({ transactions, statements, rules, currency });
  }, []);

  useEffect(() => {
    openDatabase()
      .then(async ({ driver, persistent }) => {
        const store = new FinanceStore(driver);
        await load(store);
        setState({ store, persistent });
      })
      .catch(() => setError("dbError"));
  }, [load]);

  const value = useMemo(
    () => (state ? { ...data, ...state, refresh: () => load(state.store) } : null),
    [data, state, load],
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
