// Reviewed network exception (test/privacy.test.ts): the browser preview asks its own dev server, on the
// page's own origin, which migration files the folder holds right now (devServerSync.ts). Development
// only, GET only, no body, nothing about the person or their data is sent; imports nothing.

/** The migration versions the dev server reads from the folder now, or null when it does not report them. */
export async function devServerMigrations(): Promise<number[] | null> {
  if (!import.meta.env.DEV) return null;
  try {
    const response = await fetch("/__billie/dev-status", { method: "GET", cache: "no-store", credentials: "omit" });
    if (!response.ok) return null;
    const status = (await response.json()) as { migrations?: unknown };
    return Array.isArray(status.migrations) ? status.migrations.map(Number) : null;
  } catch {
    return null; // no such route (the SPA fallback answers with HTML), or no server at all
  }
}
