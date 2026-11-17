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
  const [offline, setOffline] = useState(false);
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
        setOffline(true);
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
    const reconnect = () => { if (token.current) void verify(token.current, loadCachedAccount()); };
    window.addEventListener("online", reconnect);
    return () => { cancelled = true; window.removeEventListener("online", reconnect); };
  }, [adopt, forget]);

  const signIn = useCallback(async (email: string, password: string, otp?: string) => {
    const result = await apiSignIn(email, password, otp);
    await saveToken(result.token);
    token.current = result.token;
    tokenOwner.current = identityOf(result.account);
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
    if (!token.current || tokenOwner.current !== identityOf(account)) throw new AccountError("unauthorized");
    try {
      adopt(await updateAccount(token.current, preferences));
      setOffline(false);
    } catch (error) {
      if (error instanceof AccountError && error.code === "unauthorized") await forget();
      if (error instanceof AccountError && error.code === "offline") setOffline(true);
      throw error;
    }
  }, [adopt, forget, account]);

  const getToken = useCallback(() => tokenOwner.current !== null && tokenOwner.current === identityOf(account) ? token.current : null, [account]);
  const value = useMemo(() => ({ status, account, offline, signIn, signOut, savePreferences, getToken, expire: forget }),
    [status, account, offline, signIn, signOut, savePreferences, getToken, forget]);
  return <AccountContext.Provider value={value}>{children}</AccountContext.Provider>;
}

export function useAccount(): AccountContextValue {
  const value = useContext(AccountContext);
  if (!value) throw new Error("useAccount must be used inside AccountProvider");
  return value;
}

export type { Locale };
