// Who is signed in. Signing in needs the internet once; afterwards the app opens with
// the saved session and cached account details, and refreshes them when online.
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { AccountError, fetchAccount, signIn as apiSignIn, signOutRemote, updateAccount, type Account, type AccountPreferences } from "../services/account";
import { cacheAccount, clearSession, loadCachedAccount, loadToken, saveToken } from "../services/session";
import { isLocale, useI18n, type Locale } from "../i18n";

type Status = "loading" | "signedOut" | "signedIn";

interface AccountContextValue {
  status: Status;
  account: Account | null;
  offline: boolean;
  signIn: (email: string, password: string, otp?: string) => Promise<void>;
  signOut: () => Promise<void>;
  savePreferences: (preferences: AccountPreferences) => Promise<void>;
}

const AccountContext = createContext<AccountContextValue | null>(null);

export function AccountProvider({ children }: { children: ReactNode }) {
  const { locale, setLocale } = useI18n();
  const [status, setStatus] = useState<Status>("loading");
  const [account, setAccount] = useState<Account | null>(null);
  const [offline, setOffline] = useState(false);
  const token = useRef<string | null>(null);

  const adopt = useCallback((next: Account) => {
    setAccount(next);
    cacheAccount(next);
    if (isLocale(next.locale)) setLocale(next.locale);
  }, [setLocale]);

  const forget = useCallback(async () => {
    token.current = null;
    await clearSession().catch(() => undefined);
    setAccount(null);
    setStatus("signedOut");
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const saved = await loadToken().catch(() => null);
      if (cancelled) return;
      if (!saved) return setStatus("signedOut");
      token.current = saved;
      const cached = loadCachedAccount();
      if (cached) {
        setAccount(cached);
        setStatus("signedIn");
      }
      try {
        const fresh = await fetchAccount(saved);
        if (cancelled) return;
        adopt(fresh);
        setOffline(false);
        setStatus("signedIn");
      } catch (error) {
        if (cancelled) return;
        if (error instanceof AccountError && error.code === "unauthorized") return forget();
        // Offline (or server trouble): keep working with the cached account if we have one.
        setOffline(true);
        if (!cached) setStatus("signedOut");
      }
    })();
    return () => { cancelled = true; };
  }, [adopt, forget]);

  const signIn = useCallback(async (email: string, password: string, otp?: string) => {
    const result = await apiSignIn(email, password, otp);
    await saveToken(result.token);
    token.current = result.token;
    setOffline(false);
    if (isLocale(result.account.locale)) {
      adopt(result.account);
    } else {
      // No language saved on the account yet: keep the one chosen on this screen.
      adopt({ ...result.account, locale });
      updateAccount(result.token, { locale }).then(adopt).catch(() => undefined);
    }
    setStatus("signedIn");
  }, [adopt, locale]);

  const signOut = useCallback(async () => {
    if (token.current) await signOutRemote(token.current);
    await forget();
  }, [forget]);

  const savePreferences = useCallback(async (preferences: AccountPreferences) => {
    if (!token.current) throw new AccountError("unauthorized");
    try {
      adopt(await updateAccount(token.current, preferences));
      setOffline(false);
    } catch (error) {
      if (error instanceof AccountError && error.code === "unauthorized") await forget();
      if (error instanceof AccountError && error.code === "offline") setOffline(true);
      throw error;
    }
  }, [adopt, forget]);

  const value = useMemo(() => ({ status, account, offline, signIn, signOut, savePreferences }), [status, account, offline, signIn, signOut, savePreferences]);
  return <AccountContext.Provider value={value}>{children}</AccountContext.Provider>;
}

export function useAccount(): AccountContextValue {
  const value = useContext(AccountContext);
  if (!value) throw new Error("useAccount must be used inside AccountProvider");
  return value;
}

export type { Locale };
