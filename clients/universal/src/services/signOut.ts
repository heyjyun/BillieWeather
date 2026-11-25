// Signing out is enforced by the server, which must hear about it even when the person signs out offline.
// Until it has, this device remembers only the SHA-256 digest of the token: it opens nothing, and all the
// server lets anyone do with it is end that one session. The token itself is never kept after sign-out.
import { revokeByDigest, signOutRemote } from "./account";

const KEY = "billie.revocations";
const LIMIT = 20;
/** Sessions end by themselves after 30 days; an older entry has nothing left to revoke. */
const KEEP_MS = 31 * 24 * 60 * 60 * 1000;

interface Pending { digest: string; at: number }

function read(): Pending[] {
  try {
    const list = JSON.parse(localStorage.getItem(KEY) ?? "[]") as unknown;
    if (!Array.isArray(list)) return [];
    return list.filter((item): item is Pending => typeof item?.digest === "string" && /^[0-9a-f]{64}$/.test(item.digest)
      && typeof item.at === "number" && item.at > Date.now() - KEEP_MS).slice(-LIMIT);
  } catch {
    return [];
  }
}

function write(list: Pending[]): void {
  try {
    if (list.length) localStorage.setItem(KEY, JSON.stringify(list.slice(-LIMIT)));
    else localStorage.removeItem(KEY);
  } catch {
    // storage unavailable: the direct request below is still made
  }
}

const drop = (digest: string) => write(read().filter((item) => item.digest !== digest));

export async function tokenDigest(token: string): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)));
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Remembers the sign-out first (quitting the app must not lose it), then tells the server. Never throws. */
export async function revokeToken(token: string): Promise<void> {
  const digest = await tokenDigest(token).catch(() => null);
  if (digest) write([...read().filter((item) => item.digest !== digest), { digest, at: Date.now() }]);
  if (await signOutRemote(token) && digest) drop(digest);
}

let running: Promise<void> | null = null;

/** Finishes earlier sign-outs the server has not confirmed. Called at start, when the network returns, and after signing in. */
export function finishSignOuts(): Promise<void> {
  running ??= (async () => {
    for (const { digest } of read()) {
      if (!(await revokeByDigest(digest))) return; // unreachable: keep the rest for the next time
      drop(digest);
    }
  })().finally(() => { running = null; });
  return running;
}
