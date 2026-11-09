// Import one statement file from the device into the local database.
import type { Currency } from "@billie/shared-types";
import { decodeStatementBytes, parseStatement, sha256Hex } from "@billie/finance-core";
import { StoreError, type FinanceStore } from "./store";

export async function importFile(store: FinanceStore, bytes: Uint8Array, filename: string, currency: Currency) {
  const deviceCurrency = await store.currency();
  if (deviceCurrency && deviceCurrency !== currency) {
    throw new StoreError("currency_mismatch", `This device keeps statements in ${deviceCurrency}. Delete local data to switch currency.`, { currency: deviceCurrency });
  }
  const text = decodeStatementBytes(bytes, filename);
  const parsed = parseStatement(text, { filename, currency, categorizer: await store.categorizer() });
  const sha256 = await sha256Hex(bytes);
  const result = await store.importStatement({ filename, currency, sha256, parsed });
  return { ...result, count: parsed.rows.length, closingBalanceCents: parsed.closingBalanceCents };
}
