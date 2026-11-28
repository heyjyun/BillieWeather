// Reviewed network exception (test/privacy.test.ts): the browser preview asks its own dev server, on the
// page's own origin, which migration files the folder holds right now (devServerSync.ts). Development
// only, GET only, no body, nothing about the person or their data is sent; imports nothing.

export interface PreviewInputs {
  migrations: number[];
  migrationDigest: string;
  catalog: { version: number; digest: string };
  stale: boolean;
}

/** Download only the public fingerprints that the dev server reads from disk. */
export async function devServerInputs(): Promise<PreviewInputs | null> {
  if (!import.meta.env.DEV) return null;
  try {
    const response = await fetch("/__billie/dev-status", { method: "GET", cache: "no-store", credentials: "omit" });
    if (!response.ok) return null;
    const status = (await response.json()) as Partial<PreviewInputs>;
    if (!Array.isArray(status.migrations) || !status.migrations.every(Number.isSafeInteger) ||
      typeof status.migrationDigest !== "string" || !Number.isSafeInteger(status.catalog?.version) ||
      typeof status.catalog?.digest !== "string" || typeof status.stale !== "boolean") return null;
    return status as PreviewInputs;
  } catch {
    return null; // no such route (the SPA fallback answers with HTML), or no server at all
  }
}
