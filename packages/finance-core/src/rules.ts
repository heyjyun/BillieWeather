// "Remember my change" (app/models/finance/merchant_rule.rb + Categorizer.apply_rule_to_uncategorized).
import type { Category, MerchantRule, Transaction } from "@billie/shared-types";
import { Categorizer, merchantKey } from "./categorizer";

/** The rule to save when someone recategorizes a transaction, or null when none can be made. */
export function ruleFor(transaction: Pick<Transaction, "description" | "amountCents">, category: Category): MerchantRule | null {
  const key = merchantKey(transaction.description);
  if (key === null || category === "Uncategorized") return null;
  return { merchantKey: key, income: transaction.amountCents > 0, category };
}

/** Uncategorized transactions (other than `exceptId`) that a new rule should now categorize. */
export function transactionsMatchingRule(transactions: readonly Transaction[], rule: MerchantRule, exceptId?: number): Transaction[] {
  return transactions.filter((transaction) =>
    transaction.id !== exceptId &&
    transaction.category === "Uncategorized" &&
    transaction.amountCents > 0 === rule.income &&
    merchantKey(transaction.description) === rule.merchantKey);
}

/** Re-run today's rules over Uncategorized rows only; categories a person chose are never changed. */
export function recategorizeUncategorized(transactions: readonly Transaction[], rules: readonly MerchantRule[]): Array<{ id: number; category: Category }> {
  const categorizer = new Categorizer(rules);
  return transactions.flatMap((transaction) => {
    if (transaction.category !== "Uncategorized") return [];
    const category = categorizer.categorize(transaction.description, transaction.amountCents);
    return category === "Uncategorized" ? [] : [{ id: transaction.id, category }];
  });
}
