import { decimalToCents } from "@billie/finance-core";

export type QuickEntry = { kind: "expense" | "income"; amount: string; description: string };

const syntax = /^(spent|paid|received|earned|expense|income|支出|收入|花了|收到)\s+(\d{1,12}(?:[.,]\d{1,2})?)\s+(.+)$/iu;
const incomeWords = new Set(["received", "earned", "income", "收入", "收到"]);

/** Prefills a manual draft. Requires explicit direction and amount in the ledger's currency. */
export function parseQuickEntry(text: string): QuickEntry | null {
  const result = syntax.exec(text.trim().replace(/[ \t]+/gu, " "));
  if (!result) return null;
  const word = result[1].toLowerCase();
  const kind = incomeWords.has(word) ? "income" : "expense";
  const amount = result[2].replace(",", ".");
  const description = result[3].replace(/^(?:on|from|for)\s+/iu, "").trim();
  if (!description || description.length > 160 || decimalToCents(amount) <= 0) return null;
  return { kind, amount, description };
}
