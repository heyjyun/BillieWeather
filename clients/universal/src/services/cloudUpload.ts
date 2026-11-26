// The one place a statement leaves the device, and only when the person starts a transfer
// from a local database into the cloud on the Data page (or ticks "also keep in the cloud").
// One statement per request, to the person's own account; never anything automatic.
import { centsToDecimalString } from "@billie/finance-core";
import { API_ORIGIN, AccountError } from "./account";
import type { TransferStatement } from "./store";

const ENDPOINT = `${API_ORIGIN}/api/client/v1/finance/statements`;

/** Sends one statement. `created` is false when the cloud already had that file. */
export async function uploadStatement(token: string, statement: TransferStatement): Promise<{ id: number; created: boolean }> {
  let response: Response;
  try {
    response = await fetch(ENDPOINT, {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        statement: {
          filename: statement.filename, currency: statement.currency, sha256: statement.sha256,
          closing_balance: statement.closingBalanceCents === null ? null : centsToDecimalString(statement.closingBalanceCents),
          closing_balance_on: statement.closingBalanceOn,
          // Bank, last four digits and kind only (never a full number), so the website files the
          // statement under the same account as its own imports of that account.
          ...(statement.account ? { account: { institution: statement.account.institution, last4: statement.account.last4, kind: statement.account.kind } } : {}),
          // The rows' categories and their ancestors, parents first (name, parent, kind only), so the
          // website creates the missing ones in the same place of the tree. Older servers ignore it.
          ...(statement.categories?.length ? { categories: statement.categories.map((category) => ({ name: category.name, parent: category.parent, kind: category.kind })) } : {}),
          transactions: statement.rows.map((row) => ({
            booked_on: row.bookedOn, description: row.description, amount: centsToDecimalString(row.amountCents),
            category: row.category, tax_review: row.taxReview, excluded: row.excluded,
            kind: row.kind, original_description: row.originalDescription,
          })),
        },
      }),
      credentials: "omit",
      cache: "no-store",
    });
  } catch {
    throw new AccountError("offline");
  }
  const json = (await response.json().catch(() => ({}))) as { id?: number; created?: boolean; error?: string };
  if (response.status === 401) throw new AccountError("unauthorized");
  if (response.status === 429) throw new AccountError("rate_limited");
  if (response.status === 409) throw new AccountError("invalid", "currency_mismatch");
  if (!response.ok) throw new AccountError("unknown");
  return { id: Number(json.id), created: json.created === true };
}
