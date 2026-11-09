// Where the sign-in token and the cached account details live on this device.
// Token: system keychain (via Rust commands) in the app; sessionStorage in the browser preview.
// Account details (email, nickname, language…) are cached so the app works offline.
import type { Account } from "./account";
import { isTauri } from "./platform";

const ACCOUNT_KEY = "billie.account";

export async function loadToken(): Promise<string | null> {
  if (isTauri()) {
    const { invoke } = await import("@tauri-apps/api/core");
    return (await invoke<string | null>("session_load")) ?? null;
  }
  return sessionStorage.getItem("billie.token");
}

export async function saveToken(token: string): Promise<void> {
  if (isTauri()) {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("session_save", { token });
    return;
  }
  sessionStorage.setItem("billie.token", token);
}

export async function clearSession(): Promise<void> {
  if (isTauri()) {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("session_clear");
  } else {
    sessionStorage.removeItem("billie.token");
  }
  try {
    localStorage.removeItem(ACCOUNT_KEY);
  } catch {
    // storage unavailable
  }
}

export function loadCachedAccount(): Account | null {
  try {
    const raw = localStorage.getItem(ACCOUNT_KEY);
    return raw ? (JSON.parse(raw) as Account) : null;
  } catch {
    return null;
  }
}

export function cacheAccount(account: Account): void {
  try {
    localStorage.setItem(ACCOUNT_KEY, JSON.stringify(account));
  } catch {
    // storage unavailable
  }
}

export async function openExternal(url: string): Promise<void> {
  if (isTauri()) {
    const { openUrl } = await import("@tauri-apps/plugin-opener");
    await openUrl(url);
  } else {
    window.open(url, "_blank", "noopener");
  }
}
