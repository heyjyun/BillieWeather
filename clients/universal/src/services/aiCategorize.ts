// "Categorize with AI": the one request that sends transaction text off the device, and only
// after the person confirms the consent panel on the Categories page. It goes to the person's
// own BillieWeather server, which holds the OpenAI key and asks OpenAI with store: false; the
// app never talks to OpenAI and holds no key.
//
// Sent, per merchant: a short key, the description already cleaned on this device
// (cleanForAi: no digits, no email addresses) and "in"/"out". Plus the names of the person's
// own categories. Never amounts, dates, balances, statement names or ids. The body is built
// field by field below; test/privacy.test.ts pins it.
import { API_ORIGIN, AccountError } from "./account";

const ENDPOINT = `${API_ORIGIN}/api/client/v1/finance/categorize`;

export interface AiItem {
  key: string;
  text: string;
  direction: "in" | "out";
}

export type AiErrorCode = "wait" | "not_configured" | "failed";

export class AiCategorizeError extends Error {
  constructor(public code: AiErrorCode) {
    super(code);
    this.name = "AiCategorizeError";
  }
}

/** Returns the server's suggestions: one category name per key it could place. */
export async function requestAiCategories(token: string, items: readonly AiItem[], customCategories: readonly string[]): Promise<Array<{ key: string; category: string }>> {
  let response: Response;
  try {
    response = await fetch(ENDPOINT, {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        consent: true,
        categories: [...customCategories],
        items: items.map((item) => ({ key: item.key, description: item.text, direction: item.direction })),
      }),
      credentials: "omit",
      cache: "no-store",
    });
  } catch {
    throw new AccountError("offline");
  }
  const json = (await response.json().catch(() => ({}))) as { assignments?: unknown; error?: string };
  if (response.status === 401) throw new AccountError("unauthorized");
  if (response.status === 429) throw new AiCategorizeError("wait");
  if (response.status === 503 && json.error === "not_configured") throw new AiCategorizeError("not_configured");
  if (!response.ok || !Array.isArray(json.assignments)) throw new AiCategorizeError("failed");
  return json.assignments.flatMap((entry: unknown) => {
    const row = entry as { key?: unknown; category?: unknown };
    return typeof row.key === "string" && typeof row.category === "string" ? [{ key: row.key, category: row.category }] : [];
  });
}
