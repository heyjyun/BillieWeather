// "Categorize with AI": the one request that sends transaction text off the device, and only
// after the person confirms the consent panel on the Categories page. It goes to the person's
// own BillieWeather server, which holds the OpenAI key and asks OpenAI with store: false; the
// app never talks to OpenAI and holds no key.
//
// Sent, per merchant: a short key, the description already cleaned on this device
// (cleanForAi: no digits, no email addresses) and "in"/"out". Plus the person's categories, each
// as its full path ("Food & dining › Groceries", finance-core aiCategoryPaths). Never amounts, dates,
// balances, statement names or ids. The body is built field by field below; test/privacy.test.ts pins it.
//
// The answer: `assignments` ({key, category}: a category name or path) and, from servers since 2026-11,
// `proposals` ({parent, name, keys}: new subcategories it suggests). Proposals are only shown to the
// person (AiCategorizePanel); nothing is ever created without their approval.
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

/** The server's suggestions: one category (name or path) per key it could place, plus its raw `proposals` (none from older servers). */
export type AiAnswer = Array<{ key: string; category: string }> & { proposals?: unknown };

/** Returns the server's suggestions. `categories`: the category paths to choose from. */
export async function requestAiCategories(token: string, items: readonly AiItem[], customCategories: readonly string[]): Promise<AiAnswer> {
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
  const json = (await response.json().catch(() => ({}))) as { assignments?: unknown; proposals?: unknown; error?: string };
  if (response.status === 401) throw new AccountError("unauthorized");
  if (response.status === 429) throw new AiCategorizeError("wait");
  if (response.status === 503 && json.error === "not_configured") throw new AiCategorizeError("not_configured");
  if (!response.ok || !Array.isArray(json.assignments)) throw new AiCategorizeError("failed");
  const assignments = json.assignments.flatMap((entry: unknown) => {
    const row = entry as { key?: unknown; category?: unknown };
    return typeof row.key === "string" && typeof row.category === "string" ? [{ key: row.key, category: row.category }] : [];
  });
  return Object.assign(assignments, { proposals: Array.isArray(json.proposals) ? json.proposals : [] });
}
