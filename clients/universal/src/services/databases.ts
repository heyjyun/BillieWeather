// The list of databases on this device. Each one is its own SQLite file in the app's
// private folder ("slots": billieweather.db, billieweather-2.db, …); the list and which one
// is in use are kept in localStorage. Names live inside each database (its `settings` table).
// Nothing here is financial data.

export const MAX_DATABASES = 8;
const KEY = "billie.databases";

export interface DatabaseEntry { id: string; file: string }
export interface Registry { entries: DatabaseEntry[]; active: string }

export const fileForSlot = (slot: number) => (slot === 1 ? "billieweather.db" : `billieweather-${slot}.db`);
const FIRST: DatabaseEntry = { id: "1", file: fileForSlot(1) };

export function loadRegistry(): Registry {
  try {
    const parsed = JSON.parse(localStorage.getItem(KEY) ?? "null") as { ids?: unknown; active?: unknown } | null;
    const slots = Array.isArray(parsed?.ids) ? [...new Set(parsed.ids.map(Number).filter((n) => Number.isInteger(n) && n >= 1 && n <= MAX_DATABASES))].sort((a, b) => a - b) : [];
    if (slots.length > 0) {
      const entries = slots.map((n) => ({ id: String(n), file: fileForSlot(n) }));
      const active = entries.some((e) => e.id === String(parsed?.active)) ? String(parsed?.active) : entries[0].id;
      return { entries, active };
    }
  } catch {
    // Unreadable or missing: start with the first database.
  }
  return { entries: [FIRST], active: FIRST.id };
}

export function saveRegistry(registry: Registry): void {
  try {
    localStorage.setItem(KEY, JSON.stringify({ ids: registry.entries.map((e) => Number(e.id)), active: Number(registry.active) }));
  } catch {
    // Storage unavailable: the list falls back to the first database next time.
  }
}

/** The lowest unused slot, or null when all are taken. */
export function freeSlot(registry: Registry): DatabaseEntry | null {
  for (let n = 1; n <= MAX_DATABASES; n += 1) {
    if (!registry.entries.some((e) => e.id === String(n))) return { id: String(n), file: fileForSlot(n) };
  }
  return null;
}
