// The list of databases on this device. Each one is its own SQLite file in the app's
// private folder ("slots": billieweather.db, billieweather-2.db, …); the list and which one
// is in use are kept in localStorage. Names live inside each database (its `settings` table).
// Nothing here is financial data.
//
// Every signed-in account has its OWN list (review P0-1, invariant I-13): signing in as another
// account never shows, opens, downloads into or deletes the first account's databases. The
// owner is also recorded inside each database file (settings.owner_account_id), which is what
// actually protects the data; these lists only decide what is shown.

export const MAX_DATABASES = 8;
const LEGACY_KEY = "billie.databases";
const ADOPTED_KEY = "billie.databases.adoptedBy";
const OWNER_PREFIX = "billie.databases:";
const DECLINED_PREFIX = "billie.databases.declined:";

export interface DatabaseEntry { id: string; file: string }
export interface Registry { entries: DatabaseEntry[]; active: string }

export const fileForSlot = (slot: number) => (slot === 1 ? "billieweather.db" : `billieweather-${slot}.db`);
const FIRST: DatabaseEntry = { id: "1", file: fileForSlot(1) };

function parse(raw: string | null): Registry | null {
  try {
    const parsed = JSON.parse(raw ?? "null") as { ids?: unknown; active?: unknown } | null;
    const slots = Array.isArray(parsed?.ids) ? [...new Set(parsed.ids.map(Number).filter((n) => Number.isInteger(n) && n >= 1 && n <= MAX_DATABASES))].sort((a, b) => a - b) : [];
    if (slots.length > 0) {
      const entries = slots.map((n) => ({ id: String(n), file: fileForSlot(n) }));
      const active = entries.some((e) => e.id === String(parsed?.active)) ? String(parsed?.active) : entries[0].id;
      return { entries, active };
    }
  } catch {
    // Unreadable: treated as missing.
  }
  return null;
}

const read = (key: string): string | null => {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
};

/**
 * The databases listed for `owner` (an account's owner key). Without an owner (tests, previews)
 * the device-wide list is used, as before. The first account to sign in after this version takes
 * over the device-wide list from older versions; any later account starts with an empty list
 * (`entries: []`), and the app gives it a free slot of its own.
 */
export function loadRegistry(owner?: string | null, aliases: readonly string[] = []): Registry {
  if (!owner) return parse(read(LEGACY_KEY)) ?? { entries: [FIRST], active: FIRST.id };
  const own = parse(read(OWNER_PREFIX + owner));
  if (own) return own;
  // The same account under its older key (email hash before the server sent an id).
  for (const alias of aliases) {
    const previous = parse(read(OWNER_PREFIX + alias));
    if (previous) return previous;
  }
  const adoptedBy = read(ADOPTED_KEY);
  if (adoptedBy === null || adoptedBy === owner || aliases.includes(adoptedBy)) return parse(read(LEGACY_KEY)) ?? { entries: [FIRST], active: FIRST.id };
  return { entries: [], active: "" };
}

export function saveRegistry(registry: Registry, owner?: string | null): void {
  try {
    const body = JSON.stringify({ ids: registry.entries.map((e) => Number(e.id)), active: Number(registry.active) });
    if (!owner) {
      localStorage.setItem(LEGACY_KEY, body);
      return;
    }
    localStorage.setItem(OWNER_PREFIX + owner, body);
    if (read(ADOPTED_KEY) === null) localStorage.setItem(ADOPTED_KEY, owner);
  } catch {
    // Storage unavailable: the list falls back to the first database next time.
  }
}

/** Slots listed for any OTHER account on this device (never offered to `owner`). */
export function slotsOfOthers(owner: string | null | undefined, aliases: readonly string[] = []): Set<string> {
  const taken = new Set<string>();
  const mine = (key: string | null) => key === owner || (key !== null && aliases.includes(key));
  try {
    for (let i = 0; i < localStorage.length; i += 1) {
      const key = localStorage.key(i);
      if (!key) continue;
      const listedFor = key.startsWith(OWNER_PREFIX) ? key.slice(OWNER_PREFIX.length) : null;
      if (listedFor && !mine(listedFor)) for (const entry of parse(read(key))?.entries ?? []) taken.add(entry.id);
    }
    // The pre-owner list belongs to whoever adopted it.
    const adoptedBy = read(ADOPTED_KEY);
    if (adoptedBy && !mine(adoptedBy) && !read(OWNER_PREFIX + adoptedBy)) for (const entry of parse(read(LEGACY_KEY))?.entries ?? []) taken.add(entry.id);
  } catch {
    // Storage unavailable: nothing known.
  }
  return taken;
}

/** Databases this account said are not theirs (a pre-owner database with data). Never offered again to it. */
export function declinedSlots(owner: string): Set<string> {
  try {
    return new Set((JSON.parse(read(DECLINED_PREFIX + owner) ?? "[]") as unknown[]).map(String));
  } catch {
    return new Set();
  }
}

export function declineSlot(owner: string, id: string): void {
  try {
    localStorage.setItem(DECLINED_PREFIX + owner, JSON.stringify([...new Set([...declinedSlots(owner), id])]));
  } catch {
    // Storage unavailable.
  }
}

/** The lowest slot not in `registry` and not excluded, or null when all are taken. */
export function freeSlot(registry: Registry, exclude: ReadonlySet<string> = new Set()): DatabaseEntry | null {
  for (let n = 1; n <= MAX_DATABASES; n += 1) {
    const id = String(n);
    if (!registry.entries.some((e) => e.id === id) && !exclude.has(id)) return { id, file: fileForSlot(n) };
  }
  return null;
}

/** Every slot not in `registry` and not excluded, lowest first. */
export function freeSlots(registry: Registry, exclude: ReadonlySet<string> = new Set()): DatabaseEntry[] {
  const out: DatabaseEntry[] = [];
  for (let n = 1; n <= MAX_DATABASES; n += 1) {
    const id = String(n);
    if (!registry.entries.some((e) => e.id === id) && !exclude.has(id)) out.push({ id, file: fileForSlot(n) });
  }
  return out;
}

/** The owner key stored inside a database for an account: the server's immutable id, or a hash of the email from older servers. */
export async function ownerKeyFor(account: { ownerId?: string | null; email: string }): Promise<string> {
  if (account.ownerId) return `id:${account.ownerId}`;
  return emailOwnerKey(account.email);
}

export async function emailOwnerKey(email: string): Promise<string> {
  const bytes = new TextEncoder().encode(email.trim().toLowerCase());
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return `email:${[...digest].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

/**
 * What to do with a database for the signed-in owner:
 * - "mine": recorded for this owner (or for this account's email before the server sent an id: upgrade);
 * - "claim": no owner and no data, take it silently;
 * - "ask": no owner but it holds data (from an older version): ask the person once;
 * - "foreign": another account's database: never opened, listed or touched.
 */
export function ownership(recorded: string | null, me: string, myEmailKey: string, hasContent: boolean): "mine" | "upgrade" | "claim" | "ask" | "foreign" {
  if (recorded === me) return "mine";
  if (recorded && recorded === myEmailKey && me.startsWith("id:")) return "upgrade";
  if (recorded === null) return hasContent ? "ask" : "claim";
  return hasContent ? "foreign" : "claim";
}
