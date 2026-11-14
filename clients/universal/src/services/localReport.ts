// One-way metadata about this device's local databases, for the website's "Local databases"
// cards: a name, a size and a few counts. Nothing else is ever sent here. The request body is
// built from an explicit allowlist (REPORT_FIELDS); there is no way to pass a statement, a
// transaction, an amount, a file name or a path. The website only displays it; it never sends
// anything back that a device acts on (the responses are just "applied" or "ignored").
import { API_ORIGIN, AccountError } from "./account";

const DEVICES = `${API_ORIGIN}/api/client/v1/devices`;

/** The complete list of fields that may leave the device. Keep in step with the server allowlist. */
export const REPORT_FIELDS = [
  "name", "device_name", "platform", "size_bytes", "statement_count", "transaction_count", "rule_count",
  "period_start", "period_end", "modified_at", "opened_at", "synced_at", "sequence",
] as const;

export interface DatabaseReport {
  name: string;
  device_name: string;
  /** "macos", "windows", "linux", "ios" or "android" (from the native app, never guessed). */
  platform: string;
  size_bytes: number;
  statement_count: number;
  transaction_count: number;
  rule_count: number;
  period_start: string | null;
  period_end: string | null;
  modified_at: string | null;
  opened_at: string | null;
  /** When an explicit "Sync Now" last finished in this app, or null. */
  synced_at: string | null;
  sequence: number;
}

async function call(method: "PUT" | "DELETE", path: string, token: string, body?: Record<string, unknown>): Promise<void> {
  let response: Response;
  try {
    response = await fetch(`${DEVICES}${path}`, {
      method,
      headers: { Accept: "application/json", Authorization: `Bearer ${token}`, ...(body ? { "Content-Type": "application/json" } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
      credentials: "omit",
      cache: "no-store",
    });
  } catch {
    throw new AccountError("offline");
  }
  if (response.status === 401) throw new AccountError("unauthorized");
  if (response.status === 429) throw new AccountError("rate_limited");
  // The server refused this request for good (not a temporary problem): retrying will not help.
  if (response.status === 400 || response.status === 404 || response.status === 422) throw new AccountError("invalid");
  if (!response.ok) throw new AccountError("unknown");
}

/** Creates or updates one database's card. Safe to repeat. */
export async function putDatabaseReport(token: string, deviceId: string, databaseId: string, report: DatabaseReport): Promise<void> {
  const database: Record<string, unknown> = {};
  for (const field of REPORT_FIELDS) database[field] = report[field];
  await call("PUT", `/${deviceId}/databases/${databaseId}`, token, { database });
}

/** Removes one database's card. `sequence` orders it after any earlier report. */
export async function deleteDatabaseReport(token: string, deviceId: string, databaseId: string, sequence: number): Promise<void> {
  await call("DELETE", `/${deviceId}/databases/${databaseId}?sequence=${Math.trunc(sequence)}`, token);
}

/** Removes everything this device ever reported. */
export async function purgeDeviceReports(token: string, deviceId: string, sequence: number): Promise<void> {
  await call("DELETE", `/${deviceId}?sequence=${Math.trunc(sequence)}`, token);
}
