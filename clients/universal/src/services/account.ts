// The ONLY module that talks to the network. It sends sign-in details and account
// preferences to the BillieWeather Rails API and receives account information back.
// It must never import financial code or data (enforced by test/privacy.test.ts).

const configured = (import.meta.env.VITE_BILLIE_API_URL as string | undefined)?.trim();
/** Origin of the BillieWeather server, set at build time by scripts/tauri.mjs. */
export const API_ORIGIN = new URL(configured || "http://localhost:3000").origin;
const API = `${API_ORIGIN}/api/client/v1`;

export interface Account {
  email: string;
  nickname: string | null;
  locale: string | null;
  timeZone: string | null;
  usageRegion: string | null;
  registeredAt: string | null;
  badges: string[];
  /** The account's immutable id (server `finance_owner_uid`); null from older servers. Binds local databases to this account. */
  ownerId: string | null;
}

export interface AccountPreferences {
  locale?: string;
  nickname?: string;
  time_zone?: string;
}

export type AccountErrorCode = "invalid_credentials" | "locked" | "otp_required" | "invalid_otp" | "rate_limited" | "unconfirmed" | "unauthorized" | "invalid"
  | "offline" | "unreachable" | "local_server_down" | "server_error" | "unknown";

/** True when this build talks to a development server on this computer (never a release build; see scripts/tauri.mjs). */
export const USES_LOCAL_SERVER = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(API_ORIGIN);

/**
 * Why a request never got an answer. "offline": this device has no network. "local_server_down": a
 * development build whose server on this computer is not running. "unreachable": the network is up
 * but the BillieWeather server did not answer (down, starting up, or blocked).
 */
export function networkFailure(local: boolean = USES_LOCAL_SERVER): "offline" | "unreachable" | "local_server_down" {
  if (typeof navigator !== "undefined" && navigator.onLine === false) return "offline";
  return local ? "local_server_down" : "unreachable";
}

export const isNetworkFailure = (code: string): boolean => code === "offline" || code === "unreachable" || code === "local_server_down";

export class AccountError extends Error {
  constructor(public code: AccountErrorCode, message: string = code) {
    super(message);
    this.name = "AccountError";
  }
}

interface AccountJson {
  email: string; nickname: string | null; locale: string | null; time_zone: string | null;
  usage_region: string | null; registered_at: string | null; badges?: string[]; owner_id?: string | null;
}

const toAccount = (json: AccountJson): Account => ({
  email: json.email, nickname: json.nickname, locale: json.locale, timeZone: json.time_zone,
  usageRegion: json.usage_region, registeredAt: json.registered_at, badges: json.badges ?? [],
  ownerId: typeof json.owner_id === "string" && /^[0-9a-f-]{36}$/i.test(json.owner_id) ? json.owner_id.toLowerCase() : null,
});

async function request<T>(path: string, init: { method: string; token?: string; body?: unknown }): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${API}${path}`, {
      method: init.method,
      headers: {
        Accept: "application/json",
        ...(init.body ? { "Content-Type": "application/json" } : {}),
        ...(init.token ? { Authorization: `Bearer ${init.token}` } : {}),
      },
      body: init.body ? JSON.stringify(init.body) : undefined,
      credentials: "omit",
      cache: "no-store",
    });
  } catch {
    throw new AccountError(networkFailure());
  }
  if (response.status >= 500) throw new AccountError("server_error");
  if (response.status === 204) return undefined as T;
  const json = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) {
    const known: AccountErrorCode[] = ["invalid_credentials", "locked", "otp_required", "invalid_otp", "rate_limited", "unconfirmed", "unauthorized", "invalid"];
    const code: AccountErrorCode = known.find((candidate) => candidate === json.error) ?? (response.status === 401 ? "unauthorized" : "unknown");
    throw new AccountError(code, typeof json.message === "string" ? json.message : code);
  }
  return json as T;
}

export async function signIn(email: string, password: string, otpAttempt?: string): Promise<{ token: string; expiresAt: string; account: Account }> {
  const json = await request<{ token: string; expires_at: string; account: AccountJson }>("/session", {
    method: "POST",
    body: { email, password, ...(otpAttempt ? { otp_attempt: otpAttempt } : {}) },
  });
  return { token: json.token, expiresAt: json.expires_at, account: toAccount(json.account) };
}

export async function fetchAccount(token: string): Promise<Account> {
  return toAccount((await request<{ account: AccountJson }>("/account", { method: "GET", token })).account);
}

export async function updateAccount(token: string, preferences: AccountPreferences): Promise<Account> {
  return toAccount((await request<{ account: AccountJson }>("/account", { method: "PATCH", token, body: { account: preferences } })).account);
}

/** Ends this session on the server; true once the server has confirmed it. The token is discarded locally either way. */
export async function signOutRemote(token: string): Promise<boolean> {
  return request<void>("/session", { method: "DELETE", token }).then(() => true, () => false);
}

/** Ends a session whose token this device no longer has (see services/signOut.ts); true once confirmed. */
export async function revokeByDigest(digest: string): Promise<boolean> {
  return request<void>("/session/revocations", { method: "POST", body: { token_digest: digest } }).then(() => true, () => false);
}

/** Signs every other app and browser out of this account; this app stays signed in. Returns how many sessions ended. */
export async function signOutOthers(token: string): Promise<number> {
  return (await request<{ revoked: number }>("/sessions", { method: "DELETE", token })).revoked;
}

/** Pages on the BillieWeather website (password reset, account settings). Sign-up happens in the app (pages/Register.tsx). */
export function websiteUrl(path: "/users/password/new" | "/app/settings" | "/app/insights", locale?: string): string {
  const url = new URL(path, API_ORIGIN);
  if (locale) url.searchParams.set("locale", locale);
  return url.toString();
}
