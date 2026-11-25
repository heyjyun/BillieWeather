// Who is signed in. Signing in needs the internet once; afterwards the app opens with
// the saved session and cached account details, and refreshes them when online.
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { AccountError, fetchAccount, isNetworkFailure, signIn as apiSignIn, signOutOthers as apiSignOutOthers, updateAccount, type Account, type AccountPreferences } from "../services/account";
import { cacheAccount, clearSession, loadCachedAccount, loadToken, saveToken } from "../services/session";
import { finishSignOuts, revokeToken } from "../services/signOut";
import { isLocale, useI18n, type Locale } from "../i18n";

type Status = "loading" | "signedOut" | "signedIn";

interface AccountContextValue {
  status: Status;
  account: Account | null;
  offline: boolean;
  /** Why the server can't be reached while signed in from the cached session: no network, or the server isn't answering. */
  offlineReason: "offline" | "unreachable" | null;
  /** True while reconnect() is checking the server. */
  reconnecting: boolean;
  /** Checks the server again now (the Retry button); local data stays open whatever the outcome. */
  reconnect: () => Promise<void>;
  signIn: (email: string, password: string, otp?: string) => Promise<void>;
  signOut: () => Promise<void>;
  /** Signs every other app and browser out of this account. Returns how many sessions ended. */
  signOutOthers: () => Promise<number>;
  savePreferences: (preferences: AccountPreferences) => Promise<void>;
  /** The sign-in token, for the website-data download. Never shown or logged. */
  getToken: () => string | null;
  /** Called when the server says the token is no longer valid. */
  expire: () => Promise<void>;
}

const AccountContext = createContext<AccountContextValue | null>(null);
const identityOf = (account: Account | null) => account ? account.ownerId ? `id:${account.ownerId}` : `email:${account.email.trim().toLowerCase()}` : null;

export function AccountProvider({ children }: { children: ReactNode }) {
  const { locale, setLocale } = useI18n();
  const [status, setStatus] = useState<Status>("loading");
  const [account, setAccount] = useState<Account | null>(null);
  const [offlineReason, setOfflineReason] = useState<"offline" | "unreachable" | null>(null);
  const offline = offlineReason !== null;
  const setOffline = useCallback((value: boolean | "offline" | "unreachable") => {
    setOfflineReason(value === false ? null : value === "offline" ? "offline" : "unreachable");
  }, []);
  const [reconnecting, setReconnecting] = useState(false);
  const verifyRef = useRef<((saved: string, cached: Account | null) => Promise<void>) | null>(null);
  const token = useRef<string | null>(null);
  // Keychain and cached account writes can be interrupted independently. Until the server binds
  // this token to an identity, cached local data may be opened offline but must not sync or upload.
  const tokenOwner = useRef<string | null>(null);

  const adopt = useCallback((next: Account) => {
    setAccount(next);
    cacheAccount(next);
    if (isLocale(next.locale)) setLocale(next.locale);
  }, [setLocale]);

  const forget = useCallback(async () => {
    token.current = null;
    tokenOwner.current = null;
    await clearSession().catch(() => undefined);
    setAccount(null);
    setStatus("signedOut");
  }, []);

  useEffect(() => {
    let cancelled = false;
    const verify = async (saved: string, cached: Account | null) => {
      try {
        const fresh = await fetchAccount(saved);
        if (cancelled || token.current !== saved) return;
        tokenOwner.current = identityOf(fresh);
        adopt(fresh);
        setOffline(false);
        setStatus("signedIn");
      } catch (error) {
        if (cancelled || token.current !== saved) return;
        if (error instanceof AccountError && error.code === "unauthorized") return forget();
        // Offline (or server trouble): keep working with the cached account if we have one.
        setOffline(error instanceof AccountError && error.code === "offline" ? "offline" : "unreachable");
        if (!cached) setStatus("signedOut");
      }
    };
    (async () => {
      const saved = await loadToken().catch(() => null);
      if (cancelled) return;
      if (!saved) return setStatus("signedOut");
      if (token.current !== saved) tokenOwner.current = null;
      token.current = saved;
      const cached = loadCachedAccount();
      if (cached) {
        setAccount(cached);
        setStatus("signedIn");
      }
      await verify(saved, cached);
    })();
    verifyRef.current = verify;
    void finishSignOuts();
    const reconnect = () => { void finishSignOuts(); if (token.current) void verify(token.current, loadCachedAccount()); };
    window.addEventListener("online", reconnect);
    return () => { cancelled = true; verifyRef.current = null; window.removeEventListener("online", reconnect); };
  }, [adopt, forget, setOffline]);

  const reconnect = useCallback(async () => {
    const saved = token.current;
    if (!saved || !verifyRef.current) return;
    setReconnecting(true);
    try {
      await verifyRef.current(saved, loadCachedAccount());
    } finally {
      setReconnecting(false);
    }
  }, []);

  const signIn = useCallback(async (email: string, password: string, otp?: string) => {
    const result = await apiSignIn(email, password, otp);
    const previous = token.current;
    try {
      await saveToken(result.token);
    } catch (error) {
      await revokeToken(result.token); // this device could not keep it, so nobody should be able to use it
      throw error;
    }
    token.current = result.token;
    if (previous && previous !== result.token) void revokeToken(previous);
    void finishSignOuts();
    tokenOwner.current = identityOf(result.account);
    setOffline(false);
    if (isLocale(result.account.locale)) {
      adopt(result.account);
    } else {
      // No language saved on the account yet: keep the one chosen on this screen.
      adopt({ ...result.account, locale });
      updateAccount(result.token, { locale }).then((next) => {
        if (token.current === result.token && tokenOwner.current === identityOf(next)) adopt(next);
      }).catch(() => undefined);
    }
    setStatus("signedIn");
  }, [adopt, locale]);

  const signOut = useCallback(async () => {
    const saved = token.current;
    await forget();
    if (saved) await revokeToken(saved);
  }, [forget]);

  const signOutOthers = useCallback(async () => {
    const saved = token.current;
    if (!saved || tokenOwner.current !== identityOf(account)) throw new AccountError("unauthorized");
    try {
      return await apiSignOutOthers(saved);
    } catch (error) {
      if (token.current === saved && error instanceof AccountError && error.code === "unauthorized") await forget();
      throw error;
    }
  }, [account, forget]);

  const savePreferences = useCallback(async (preferences: AccountPreferences) => {
    const saved = token.current;
    if (!saved || tokenOwner.current !== identityOf(account)) throw new AccountError("unauthorized");
    try {
      const next = await updateAccount(saved, preferences);
      if (token.current !== saved || tokenOwner.current !== identityOf(next)) return;
      adopt(next);
      setOffline(false);
    } catch (error) {
      if (token.current !== saved) return;
      if (error instanceof AccountError && error.code === "unauthorized") await forget();
      if (error instanceof AccountError && isNetworkFailure(error.code)) setOffline(error.code === "offline" ? "offline" : "unreachable");
      throw error;
    }
  }, [adopt, forget, account, setOffline]);

  const getToken = useCallback(() => tokenOwner.current !== null && tokenOwner.current === identityOf(account) ? token.current : null, [account]);
  const value = useMemo(() => ({ status, account, offline, offlineReason, reconnecting, reconnect, signIn, signOut, signOutOthers, savePreferences, getToken, expire: forget }),
    [status, account, offline, offlineReason, reconnecting, reconnect, signIn, signOut, signOutOthers, savePreferences, getToken, forget]);
  return <AccountContext.Provider value={value}>{children}</AccountContext.Provider>;
}

export function useAccount(): AccountContextValue {
  const value = useContext(AccountContext);
  if (!value) throw new Error("useAccount must be used inside AccountProvider");
  return value;
}

export type { Locale };
