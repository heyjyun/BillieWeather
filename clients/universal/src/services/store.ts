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
  source: row.source === "web" ? "web" : "local",
});
const toTransaction = (row: Row): Transaction => ({
  id: Number(row.id), statementId: Number(row.statement_id), bookedOn: String(row.booked_on), description: String(row.description),
  amountCents: Number(row.amount_cents), category: row.category as Category, taxReview: Number(row.tax_review) === 1, excluded: Number(row.excluded) === 1,
});

/** Financial data downloaded (read-only) from the person's BillieWeather web account. */
export interface WebData {
  currency: Currency | null;
  statements: Array<{ remoteId: number; filename: string; currency: Currency; sha256: string; transactionCount: number; closingBalanceCents: number | null; closingBalanceOn: string | null; importedAt: string }>;
  transactions: Array<{ remoteId: number; remoteStatementId: number; bookedOn: string; description: string; amountCents: number; category: Category; taxReview: boolean; excluded: boolean }>;
  rules: MerchantRule[];
}

export interface WebSyncResult {
  statementsAdded: number;
  statementsRemoved: number;
  transactionsAdded: number;
  transactionsUpdated: number;
  transactionsRemoved: number;
  skippedDuplicates: number;
}

export interface WebSyncSettings {
  enabled: boolean;
  version: string | null;
  checkedAt: string | null;
}

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
    await this.db.execute("UPDATE transactions SET locally_modified = 1 WHERE id = $1", [id]);
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
    await this.db.execute("UPDATE transactions SET excluded = $1, locally_modified = 1, updated_at = $2 WHERE id = $3", [excluded ? 1 : 0, now(), id]);
  }

  async deleteRule(rule: Pick<MerchantRule, "merchantKey" | "income">): Promise<void> {
    await this.db.execute("DELETE FROM merchant_rules WHERE merchant_key = $1 AND income = $2", [rule.merchantKey, rule.income ? 1 : 0]);
  }

  /**
   * Permanently removes every statement, transaction and rule on this device. The only
   * setting kept is whether website download is on (a preference, not financial data).
   */
  async deleteAllData(): Promise<void> {
    for (const table of ["transactions", "statements", "merchant_rules"]) await this.db.execute(`DELETE FROM ${table}`);
    await this.db.execute("DELETE FROM settings WHERE key <> $1", ["web_sync_enabled"]);
    // Reclaim freed pages so deleted rows do not linger in the database file.
    try {
      await this.db.execute("VACUUM");
    } catch {
      // Some drivers refuse VACUUM while other connections are open; the rows are already gone.
    }
  }

  async webSyncSettings(): Promise<WebSyncSettings> {
    const rows = await this.db.select<Row>("SELECT key, value FROM settings WHERE key IN ($1, $2, $3)", ["web_sync_enabled", "web_sync_version", "web_sync_checked_at"]);
    const value = (key: string) => (rows.find((row) => row.key === key)?.value as string | undefined) ?? null;
    return { enabled: value("web_sync_enabled") !== "0", version: value("web_sync_version"), checkedAt: value("web_sync_checked_at") };
  }

  async setWebSyncEnabled(enabled: boolean): Promise<void> {
    await this.setSetting("web_sync_enabled", enabled ? "1" : "0");
    if (!enabled) await this.db.execute("DELETE FROM settings WHERE key = $1", ["web_sync_version"]);
  }

  async markWebChecked(version: string | null): Promise<void> {
    await this.setSetting("web_sync_checked_at", now());
    if (version) await this.setSetting("web_sync_version", version);
  }

  /**
   * Merges a download from the website into this device's database:
   * - a statement already imported on this device (same file hash) is not added twice;
   * - website edits update the copies, except categories/exclusions changed on this device;
   * - statements and transactions deleted on the website are removed here too;
   * - remembered rules from the website are added unless this device has its own rule.
   * Statements imported on this device are never touched.
   */
  async applyWebData(web: WebData): Promise<WebSyncResult> {
    const deviceCurrency = await this.currency();
    if (deviceCurrency && web.currency && deviceCurrency !== web.currency && web.statements.length > 0) {
      throw new StoreError("currency_mismatch", `Website data is in ${web.currency}; this device uses ${deviceCurrency}.`, { currency: deviceCurrency, web: web.currency });
    }
    const result: WebSyncResult = { statementsAdded: 0, statementsRemoved: 0, transactionsAdded: 0, transactionsUpdated: 0, transactionsRemoved: 0, skippedDuplicates: 0 };
    const stamp = now();

    // Statements.
    const localRows = await this.db.select<Row>("SELECT id, sha256, source, remote_id FROM statements");
    const localHashes = new Set(localRows.filter((row) => row.source !== "web").map((row) => String(row.sha256)));
    const copies = new Map(localRows.filter((row) => row.source === "web").map((row) => [Number(row.remote_id), Number(row.id)]));
    const statementIdFor = new Map<number, number>();
    for (const statement of web.statements) {
      if (localHashes.has(statement.sha256)) {
        result.skippedDuplicates += 1;
        continue;
      }
      const existing = copies.get(statement.remoteId);
      const values = [statement.filename, statement.currency, statement.sha256, statement.transactionCount, statement.closingBalanceCents, statement.closingBalanceOn];
      if (existing) {
        await this.db.execute(
          "UPDATE statements SET filename = $1, currency = $2, sha256 = $3, transaction_count = $4, closing_balance_cents = $5, closing_balance_on = $6 WHERE id = $7",
          [...values, existing],
        );
        statementIdFor.set(statement.remoteId, existing);
      } else {
        const inserted = await this.db.execute(
          "INSERT INTO statements (filename, currency, sha256, transaction_count, closing_balance_cents, closing_balance_on, imported_at, source, remote_id) VALUES ($1, $2, $3, $4, $5, $6, $7, 'web', $8)",
          [...values, statement.importedAt || stamp, statement.remoteId],
        );
        statementIdFor.set(statement.remoteId, Number(inserted.lastInsertId));
        result.statementsAdded += 1;
      }
    }
    for (const [remoteId, localId] of copies) {
      if (statementIdFor.has(remoteId)) continue;
      await this.db.execute("DELETE FROM transactions WHERE statement_id = $1", [localId]);
      await this.db.execute("DELETE FROM statements WHERE id = $1", [localId]);
      result.statementsRemoved += 1;
    }

    // Transactions belonging to the website copies.
    const existingTx = new Map((await this.db.select<Row>("SELECT * FROM transactions WHERE remote_id IS NOT NULL")).map((row) => [Number(row.remote_id), row]));
    const incoming = web.transactions.filter((transaction) => statementIdFor.has(transaction.remoteStatementId));
    const seen = new Set<number>();
    const inserts: unknown[][] = [];
    for (const transaction of incoming) {
      seen.add(transaction.remoteId);
      const statementId = statementIdFor.get(transaction.remoteStatementId)!;
      const row = existingTx.get(transaction.remoteId);
      if (!row) {
        inserts.push([statementId, transaction.bookedOn, transaction.description, transaction.amountCents, transaction.category, transaction.taxReview ? 1 : 0, transaction.excluded ? 1 : 0, stamp, transaction.remoteId]);
        continue;
      }
      const keepLocal = Number(row.locally_modified) === 1;
      const next = {
        statement_id: statementId, booked_on: transaction.bookedOn, description: transaction.description, amount_cents: transaction.amountCents,
        category: keepLocal ? String(row.category) : transaction.category,
        tax_review: keepLocal ? Number(row.tax_review) : transaction.taxReview ? 1 : 0,
        excluded: keepLocal ? Number(row.excluded) : transaction.excluded ? 1 : 0,
      };
      const changed = (Object.keys(next) as Array<keyof typeof next>).some((key) => String(row[key]) !== String(next[key]));
      if (!changed) continue;
      await this.db.execute(
        "UPDATE transactions SET statement_id = $1, booked_on = $2, description = $3, amount_cents = $4, category = $5, tax_review = $6, excluded = $7, updated_at = $8 WHERE id = $9",
        [next.statement_id, next.booked_on, next.description, next.amount_cents, next.category, next.tax_review, next.excluded, stamp, Number(row.id)],
      );
      result.transactionsUpdated += 1;
    }
    for (let start = 0; start < inserts.length; start += 100) {
      const batch = inserts.slice(start, start + 100);
      const params = batch.flat();
      const values = batch.map((_, i) => `(${Array.from({ length: 9 }, (_, j) => `$${i * 9 + j + 1}`).join(", ")})`);
      await this.db.execute(
        `INSERT INTO transactions (statement_id, booked_on, description, amount_cents, category, tax_review, excluded, updated_at, remote_id) VALUES ${values.join(", ")}`,
        params,
      );
      result.transactionsAdded += batch.length;
    }
    for (const [remoteId, row] of existingTx) {
      if (seen.has(remoteId)) continue;
      await this.db.execute("DELETE FROM transactions WHERE id = $1", [Number(row.id)]);
      result.transactionsRemoved += 1;
    }

    // Remembered rules: this device's own rules win.
    for (const rule of web.rules) {
      await this.db.execute(
        "INSERT INTO merchant_rules (merchant_key, income, category, updated_at) VALUES ($1, $2, $3, $4) ON CONFLICT (merchant_key, income) DO NOTHING",
        [rule.merchantKey, rule.income ? 1 : 0, rule.category, stamp],
      );
    }
    if (!deviceCurrency && web.currency && web.statements.length > 0) await this.setSetting("currency", web.currency);
    return result;
  }

  private async setSetting(key: string, value: string): Promise<void> {
    await this.db.execute("INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = excluded.value", [key, value]);
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
