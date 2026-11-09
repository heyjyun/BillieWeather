// Managing the cloud database as a whole, from the Data page: rename it, or delete it
// completely. The delete only goes through with the confirmation the person typed
// (`confirm=delete` is sent only after that); statements are never sent from here.
import { API_ORIGIN, AccountError } from "./account";

const FINANCE = `${API_ORIGIN}/api/client/v1/finance`;

async function call(path: string, method: "PATCH" | "DELETE", token: string, body?: Record<string, unknown>): Promise<Record<string, unknown>> {
  let response: Response;
  try {
    response = await fetch(`${FINANCE}${path}`, {
      method,
      headers: { Accept: "application/json", Authorization: `Bearer ${token}`, ...(body ? { "Content-Type": "application/json" } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
      credentials: "omit",
      cache: "no-store",
    });
  } catch {
    throw new AccountError("offline");
  }
  const json = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (response.status === 401) throw new AccountError("unauthorized");
  if (response.status === 429) throw new AccountError("rate_limited");
  if (!response.ok) throw new AccountError("unknown");
  return json;
}

/** Names the cloud database. An empty name goes back to the default. Returns the stored name. */
export async function renameCloudDatabase(token: string, name: string): Promise<string | null> {
  const json = await call("", "PATCH", token, { name });
  return (json.name as string | null | undefined) ?? null;
}

/** Permanently deletes everything in the cloud database. Call only after the typed confirmation. */
export async function deleteCloudDatabase(token: string): Promise<void> {
  await call("?confirm=delete", "DELETE", token);
}
