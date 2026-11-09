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
}

export interface AccountPreferences {
  locale?: string;
  nickname?: string;
  time_zone?: string;
}

export type AccountErrorCode = "invalid_credentials" | "locked" | "otp_required" | "invalid_otp" | "rate_limited" | "unauthorized" | "invalid" | "offline" | "unknown";

export class AccountError extends Error {
  constructor(public code: AccountErrorCode, message: string = code) {
    super(message);
    this.name = "AccountError";
  }
}

interface AccountJson {
  email: string; nickname: string | null; locale: string | null; time_zone: string | null;
  usage_region: string | null; registered_at: string | null; badges?: string[];
}

const toAccount = (json: AccountJson): Account => ({
  email: json.email, nickname: json.nickname, locale: json.locale, timeZone: json.time_zone,
  usageRegion: json.usage_region, registeredAt: json.registered_at, badges: json.badges ?? [],
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
    throw new AccountError("offline");
  }
  if (response.status === 204) return undefined as T;
  const json = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) {
    const known: AccountErrorCode[] = ["invalid_credentials", "locked", "otp_required", "invalid_otp", "rate_limited", "unauthorized", "invalid"];
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

/** Tells the server we are leaving; the token is discarded locally either way. */
export async function signOutRemote(token: string): Promise<void> {
  await request<void>("/session", { method: "DELETE", token }).catch(() => undefined);
}

/** Pages on the BillieWeather website (sign-up, password reset, account settings). */
export function websiteUrl(path: "/users/sign_up" | "/users/password/new" | "/app/settings", locale?: string): string {
  const url = new URL(path, API_ORIGIN);
  if (locale) url.searchParams.set("locale", locale);
  return url.toString();
}
