// All reads and writes of local financial data. Talks only to the on-device SQLite
// database through `SqlDriver` (Tauri's SQL plugin in the app, sql.js in tests and the
// browser preview). Nothing here touches the network.
import type { Category, Currency, MerchantRule, ParsedStatement, Statement, Transaction } from "@billie/shared-types";
import { CURRENCIES } from "@billie/shared-types";
import { Categorizer, recategorizeUncategorized, ruleFor, transactionsMatchingRule } from "@billie/finance-core";

export interface SqlDriver {
  execute(sql: string, params?: unknown[]): Promise<{ rowsAffected: number; lastInsertId?: number }>;
  select<T>(sql: string, params?: unknown[]): Promise<T[]>;
}

export type StoreErrorCode = "statement_duplicate" | "currency_mismatch" | "unsupported_currency" | "not_found";

/** `code` matches a Rails billie.backend.* key where one exists, so the message can be translated. */
export class StoreError extends Error {
  constructor(public code: StoreErrorCode, message: string, public vars: Record<string, string | number> = {}) {
    super(message);
    this.name = "StoreError";
  }
}

type Row = Record<string, unknown>;
const now = () => new Date().toISOString();

const toStatement = (row: Row): Statement => ({
  id: Number(row.id), filename: String(row.filename), currency: row.currency as Currency, sha256: String(row.sha256),
  transactionCount: Number(row.transaction_count),
  closingBalanceCents: row.closing_balance_cents === null ? null : Number(row.closing_balance_cents),
  closingBalanceOn: (row.closing_balance_on as string | null) ?? null, importedAt: String(row.imported_at),
});
const toTransaction = (row: Row): Transaction => ({
  id: Number(row.id), statementId: Number(row.statement_id), bookedOn: String(row.booked_on), description: String(row.description),
  amountCents: Number(row.amount_cents), category: row.category as Category, taxReview: Number(row.tax_review) === 1, excluded: Number(row.excluded) === 1,
});

export class FinanceStore {
  constructor(private db: SqlDriver) {}

  /** The currency is fixed by the first import, like the Rails profile. */
  async currency(): Promise<Currency | null> {
    const rows = await this.db.select<Row>("SELECT value FROM settings WHERE key = $1", ["currency"]);
    return (rows[0]?.value as Currency | undefined) ?? null;
  }

  async statements(): Promise<Statement[]> {
    return (await this.db.select<Row>("SELECT * FROM statements ORDER BY id")).map(toStatement);
  }

  async transactions(): Promise<Transaction[]> {
    return (await this.db.select<Row>("SELECT * FROM transactions ORDER BY booked_on DESC, id DESC")).map(toTransaction);
  }

  async rules(): Promise<MerchantRule[]> {
    return (await this.db.select<Row>("SELECT * FROM merchant_rules ORDER BY merchant_key")).map((row) => ({
      merchantKey: String(row.merchant_key), income: Number(row.income) === 1, category: row.category as MerchantRule["category"],
    }));
  }

  async categorizer(): Promise<Categorizer> {
    return new Categorizer(await this.rules());
  }

  /**
   * Saves a parsed statement. The same file (by SHA-256) is never imported twice, and
   * one device keeps one currency. If inserting rows fails part-way, everything written
   * for this statement is removed again.
   */
  async importStatement(input: { filename: string; currency: Currency; sha256: string; parsed: ParsedStatement }): Promise<{ statementId: number; recategorized: number }> {
    if (!(CURRENCIES as readonly string[]).includes(input.currency)) throw new StoreError("unsupported_currency", "That currency is not supported.");
    const existingCurrency = await this.currency();
    if (existingCurrency && existingCurrency !== input.currency) {
      throw new StoreError("currency_mismatch", `This device keeps statements in ${existingCurrency}. Delete local data to switch currency.`, { currency: existingCurrency });
    }
    const duplicate = await this.db.select<Row>("SELECT id FROM statements WHERE sha256 = $1", [input.sha256]);
    if (duplicate.length > 0) throw new StoreError("statement_duplicate", "This statement was already imported.");

    const stamp = now();
    const result = await this.db.execute(
      "INSERT INTO statements (filename, currency, sha256, transaction_count, closing_balance_cents, closing_balance_on, imported_at) VALUES ($1, $2, $3, $4, $5, $6, $7)",
      [input.filename, input.currency, input.sha256, input.parsed.rows.length, input.parsed.closingBalanceCents, input.parsed.closingBalanceOn, stamp],
    );
    const statementId = Number(result.lastInsertId);
    try {
      for (let start = 0; start < input.parsed.rows.length; start += 100) {
        const batch = input.parsed.rows.slice(start, start + 100);
        const params: unknown[] = [];
        const values = batch.map((row) => {
          const base = params.length;
          params.push(statementId, row.bookedOn, row.description, row.amountCents, row.category, row.taxReview ? 1 : 0, row.excluded ? 1 : 0, stamp);
          return `(${Array.from({ length: 8 }, (_, i) => `$${base + i + 1}`).join(", ")})`;
        });
        await this.db.execute(
          `INSERT INTO transactions (statement_id, booked_on, description, amount_cents, category, tax_review, excluded, updated_at) VALUES ${values.join(", ")}`,
          params,
        );
      }
      if (!existingCurrency) await this.db.execute("INSERT OR REPLACE INTO settings (key, value) VALUES ($1, $2)", ["currency", input.currency]);
    } catch (error) {
      await this.db.execute("DELETE FROM transactions WHERE statement_id = $1", [statementId]);
      await this.db.execute("DELETE FROM statements WHERE id = $1", [statementId]);
      throw error;
    }
    // Like Rails: newer rules also clean up older Uncategorized rows.
    const recategorized = await this.applyCategories(recategorizeUncategorized(await this.transactions(), await this.rules()));
    return { statementId, recategorized };
  }

  /**
   * Changes a transaction's category. With `remember`, saves a merchant rule and applies
   * it to other Uncategorized transactions from the same merchant and direction.
   * Returns how many other transactions changed.
   */
  async setCategory(id: number, category: Category, remember: boolean): Promise<number> {
    const [row] = await this.db.select<Row>("SELECT * FROM transactions WHERE id = $1", [id]);
    if (!row) throw new StoreError("not_found", "Transaction not found.");
    const transaction = toTransaction(row);
    await this.applyCategories([{ id, category }]);
    if (!remember) return 0;
    const rule = ruleFor(transaction, category);
    if (!rule) return 0;
    await this.db.execute(
      "INSERT INTO merchant_rules (merchant_key, income, category, updated_at) VALUES ($1, $2, $3, $4) ON CONFLICT (merchant_key, income) DO UPDATE SET category = excluded.category, updated_at = excluded.updated_at",
      [rule.merchantKey, rule.income ? 1 : 0, rule.category, now()],
    );
    return this.applyCategories(transactionsMatchingRule(await this.transactions(), rule, id).map((match) => ({ id: match.id, category })));
  }

  async setExcluded(id: number, excluded: boolean): Promise<void> {
    await this.db.execute("UPDATE transactions SET excluded = $1, updated_at = $2 WHERE id = $3", [excluded ? 1 : 0, now(), id]);
  }

  async deleteRule(rule: Pick<MerchantRule, "merchantKey" | "income">): Promise<void> {
    await this.db.execute("DELETE FROM merchant_rules WHERE merchant_key = $1 AND income = $2", [rule.merchantKey, rule.income ? 1 : 0]);
  }

  /** Permanently removes every statement, transaction, rule and setting on this device. */
  async deleteAllData(): Promise<void> {
    for (const table of ["transactions", "statements", "merchant_rules", "settings"]) await this.db.execute(`DELETE FROM ${table}`);
    // Reclaim freed pages so deleted rows do not linger in the database file.
    try {
      await this.db.execute("VACUUM");
    } catch {
      // Some drivers refuse VACUUM while other connections are open; the rows are already gone.
    }
  }

  private async applyCategories(changes: Array<{ id: number; category: Category }>): Promise<number> {
    const stamp = now();
    for (const change of changes) {
      // Business purchases are flagged for tax review, as in Rails.
      await this.db.execute(
        "UPDATE transactions SET category = $1, tax_review = CASE WHEN $2 = 'Business' THEN 1 ELSE tax_review END, updated_at = $3 WHERE id = $4",
        [change.category, change.category, stamp, change.id],
      );
    }
    return changes.length;
  }
}
