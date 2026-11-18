// Whether to show the in-app Welcome page (src/pages/Welcome.tsx) after signing in.
//
// The welcome is for people who just created their account, not for every sign-in:
// - the server says the account is new (`registered_at` within NEW_ACCOUNT_DAYS), so an existing
//   account never sees it, on this device or any other, and older servers (no `registered_at`)
//   never trigger it;
// - this account has not finished it on this device (the key is the account's owner key, the same
//   one that binds local databases to an account, so switching accounts never shares the flag);
// - the open local book is still empty, so someone who already imported or synced data goes
//   straight to their dashboard.
// Finishing means pressing one of its buttons; closing the app on the welcome shows it again.
// Nothing here touches SQLite, the network, or any financial data: one localStorage flag only.

export const NEW_ACCOUNT_DAYS = 30;
const PREFIX = "billie.welcome.";

const keyFor = (ownerKey: string) => `${PREFIX}${ownerKey}`;

export function isWelcomeDone(ownerKey: string): boolean {
  try {
    return localStorage.getItem(keyFor(ownerKey)) !== null;
  } catch {
    return true; // storage unavailable: never trap anyone on the welcome
  }
}

/** Records that this account finished the welcome. Never throws: the navigation must still happen. */
export function markWelcomeDone(ownerKey: string, now: Date = new Date()): void {
  try {
    localStorage.setItem(keyFor(ownerKey), now.toISOString());
  } catch {
    // storage unavailable: the welcome may show once more, which is harmless
  }
}

export function isNewAccount(registeredAt: string | null, now: Date = new Date()): boolean {
  if (!registeredAt) return false;
  const registered = Date.parse(registeredAt);
  if (Number.isNaN(registered)) return false;
  const age = now.getTime() - registered;
  // A small allowance for a device clock that runs slightly behind the server.
  return age > -24 * 3600_000 && age < NEW_ACCOUNT_DAYS * 24 * 3600_000;
}

export function shouldShowWelcome(input: { ownerKey: string | null; registeredAt: string | null; hasData: boolean; now?: Date }): boolean {
  if (!input.ownerKey || input.hasData) return false;
  return isNewAccount(input.registeredAt, input.now) && !isWelcomeDone(input.ownerKey);
}
