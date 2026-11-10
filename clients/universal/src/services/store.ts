// All reads and writes of local financial data. Talks only to the on-device SQLite
// database through `SqlDriver` (Tauri's SQL plugin in the app, sql.js in tests and the
// browser preview). Nothing here touches the network.
import type { Category, Currency, MerchantRule, ParsedStatement, Statement, Transaction } from "@billie/shared-types";
import { CURRENCIES } from "@billie/shared-types";
import { aiGroups, Categorizer, categoryNameProblem, CUSTOM_CATEGORY_MAX, isBuiltInCategory, merchantKey, normalizeCategoryName, recategorizeUncategorized, ruleFor, titleizeMerchant, transactionsMatchingRule, type AiGroup, type CategoryNameProblem, type ExistingTransaction, type ImportReport, type ImportTemplate, type PlannedRow, type PlannedStatement } from "@billie/finance-core";
import { randomId } from "./ids";

export interface SqlDriver {
  execute(sql: string, params?: unknown[]): Promise<{ rowsAffected: number; lastInsertId?: number }>;
  select<T>(sql: string, params?: unknown[]): Promise<T[]>;
}

export type StoreErrorCode = "statement_duplicate" | "currency_mismatch" | "unsupported_currency" | "not_found" | "invalid_name" | "invalid_category" | "too_many_categories";

export const DATABASE_NAME_MAX = 60;

/** Collapses whitespace, drops control characters and limits the length of a database name. */
export function normalizeDatabaseName(name: string): string {
  return [...name.replace(/[\u0000-\u001f\u007f]/g, "").replace(/\s+/g, " ").trim()].slice(0, DATABASE_NAME_MAX).join("").trim();
}

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
  /** The person's own categories on the website (older servers send none). */
  categories?: string[];
}

export interface WebSyncResult {
  statementsAdded: number;
  statementsRemoved: number;
  transactionsAdded: number;
  transactionsUpdated: number;
  transactionsRemoved: number;
  skippedDuplicates: number;
}

/** One statement with all its transactions, as it travels between databases. */
export interface TransferStatement {
  filename: string;
  currency: Currency;
  sha256: string;
  closingBalanceCents: number | null;
  closingBalanceOn: string | null;
  importedAt: string;
  rows: Array<{ bookedOn: string; description: string; amountCents: number; category: Category; taxReview: boolean; excluded: boolean }>;
}

export interface TransferData {
  statements: TransferStatement[];
  rules: MerchantRule[];
  /** Custom categories, including ones no transaction uses yet. */
  categories?: string[];
}

export interface MergeResult {
  statementsAdded: number;
  transactionsAdded: number;
  rulesAdded: number;
  /** Statements the target already had (same file hash). */
  skipped: number;
}

export interface StatementInventoryItem {
  id: number;
  filename: string;
  sha256: string;
  source: "local" | "web";
  transactionCount: number;
  periodStart: string | null;
  periodEnd: string | null;
}

export interface LocalSummary {
  localStatements: number;
  webStatements: number;
  localTransactions: number;
  webTransactions: number;
  rules: number;
  currency: Currency | null;
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

  /** The person's own categories in this database, alphabetically. */
  async customCategories(): Promise<string[]> {
    return (await this.db.select<Row>("SELECT name FROM custom_categories ORDER BY name COLLATE NOCASE")).map((row) => String(row.name));
  }

  /** Adds a custom category. Returns the name as stored; throws invalid_category with a `problem`. */
  async addCategory(name: string): Promise<string> {
    const clean = normalizeCategoryName(name);
    const existing = await this.customCategories();
    this.checkCategoryName(clean, existing);
    if (existing.length >= CUSTOM_CATEGORY_MAX) throw new StoreError("too_many_categories", "Too many categories.", { max: CUSTOM_CATEGORY_MAX });
    await this.db.execute("INSERT INTO custom_categories (name, created_at) VALUES ($1, $2)", [clean, now()]);
    return clean;
  }

  /** Renames a custom category everywhere it is used. Returns the new name. */
  async renameCategory(from: string, to: string): Promise<string> {
    const existing = await this.customCategories();
    if (!existing.includes(from)) throw new StoreError("not_found", "Category not found.");
    const clean = normalizeCategoryName(to);
    this.checkCategoryName(clean, existing, from);
    if (clean === from) return clean;
    const stamp = now();
    await this.db.execute("UPDATE custom_categories SET name = $1 WHERE name = $2", [clean, from]);
    await this.db.execute("UPDATE transactions SET category = $1, locally_modified = 1, updated_at = $2 WHERE category = $3", [clean, stamp, from]);
    await this.db.execute("UPDATE merchant_rules SET category = $1, updated_at = $2 WHERE category = $3", [clean, stamp, from]);
    return clean;
  }

  /** Deletes a custom category: its transactions become Uncategorized, its rules are forgotten. Returns how many transactions moved. */
  async deleteCategory(name: string): Promise<number> {
    const [row] = await this.db.select<Row>("SELECT name FROM custom_categories WHERE name = $1", [name]);
    if (!row) throw new StoreError("not_found", "Category not found.");
    const moved = await this.db.execute("UPDATE transactions SET category = 'Uncategorized', locally_modified = 1, updated_at = $1 WHERE category = $2", [now(), name]);
    await this.db.execute("DELETE FROM merchant_rules WHERE category = $1", [name]);
    await this.db.execute("DELETE FROM custom_categories WHERE name = $1", [name]);
    return moved.rowsAffected;
  }

  /**
   * Makes sure every name coming from another database (a sync or a website download) exists
   * here as a custom category, so those transactions keep their category. Unusable names and
   * names past the limit are left out; their rows are filed as Uncategorized by `knownCategory`.
   */
  private async ensureCategories(names: Iterable<string>): Promise<Set<string>> {
    const existing = await this.customCategories();
    const known = new Map(existing.map((name) => [name.toLowerCase(), name]));
    for (const raw of names) {
      const name = normalizeCategoryName(raw);
      if (!name || isBuiltInCategory(name) || known.has(name.toLowerCase())) continue;
      if (known.size >= CUSTOM_CATEGORY_MAX || categoryNameProblem(name, [...known.values()]) !== null) continue;
      await this.db.execute("INSERT INTO custom_categories (name, created_at) VALUES ($1, $2) ON CONFLICT DO NOTHING", [name, now()]);
      known.set(name.toLowerCase(), name);
    }
    return new Set(known.values());
  }

  private checkCategoryName(name: string, existing: readonly string[], renaming?: string): void {
    const problem: CategoryNameProblem | null = categoryNameProblem(name, existing, renaming);
    if (problem) throw new StoreError("invalid_category", `Category name: ${problem}.`, { problem });
  }

  /** The stored name for a category from elsewhere: a built-in, a known custom one (any letter case), or Uncategorized. */
  private static knownCategory(name: string, custom: ReadonlySet<string>): Category {
    if (isBuiltInCategory(name)) return name;
    const clean = normalizeCategoryName(name).toLowerCase();
    for (const known of custom) if (known.toLowerCase() === clean) return known;
    return "Uncategorized";
  }

  /** Uncategorized transactions grouped by merchant, as "Categorize with AI" would send them. */
  async aiCandidates(): Promise<AiGroup[]> {
    return aiGroups(await this.transactions());
  }

  /**
   * Applies AI suggestions ({group key → category}) to the groups' transactions that are still
   * Uncategorized, so a category chosen meanwhile is never overwritten. Names that are not a
   * category here are ignored. No merchant rules are saved. Returns how many transactions changed.
   */
  async applyAiCategories(groups: readonly AiGroup[], assignments: ReadonlyArray<{ key: string; category: string }>): Promise<number> {
    const custom = new Set(await this.customCategories());
    const byKey = new Map(groups.map((group) => [group.key, group]));
    const stamp = now();
    let changed = 0;
    for (const { key, category } of assignments) {
      const group = byKey.get(key);
      if (!group || category === "Uncategorized" || category === "Transfers" || !(isBuiltInCategory(category) || custom.has(category))) continue;
      if (category === "Income" && group.direction !== "in") continue;
      byKey.delete(key);
      for (let start = 0; start < group.ids.length; start += 100) {
        const ids = group.ids.slice(start, start + 100);
        const placeholders = ids.map((_, i) => `$${i + 4}`).join(", ");
        const result = await this.db.execute(
          `UPDATE transactions SET category = $1, tax_review = CASE WHEN $2 = 'Business' THEN 1 ELSE tax_review END, updated_at = $3 WHERE category = 'Uncategorized' AND id IN (${placeholders})`,
          [category, category, stamp, ...ids],
        );
        changed += result.rowsAffected;
      }
    }
    return changed;
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
    if (duplicate.length === 0) {
      const skipped = await this.skippedHashes();
      if (skipped.delete(input.sha256)) await this.setSetting("web_sync_skip", JSON.stringify([...skipped]));
    }
    if (duplicate.length > 0) throw new StoreError("statement_duplicate", "This statement was already imported.");

    const rows: PlannedRow[] = input.parsed.rows.map((row, index) => ({
      bookedOn: row.bookedOn, postedOn: null, description: row.description, normalizedMerchant: titleizeMerchant(merchantKey(row.description)),
      amountCents: row.amountCents, currency: input.currency, direction: row.amountCents < 0 ? "debit" : row.amountCents > 0 ? "credit" : "zero",
      balanceCents: null, bankReference: null, accountKey: null, category: row.category, categorySource: "auto", taxReview: row.taxReview, pending: false,
      kindHints: "", sourceRef: `row:${index + 1}`, confidence: 100, validationStatus: "verified", raw: "{}",
    }));
    const statementId = await this.commitStaged({
      filename: input.filename, currency: input.currency, sha256: input.sha256, sourceSha256: input.sha256, batchId: randomId(),
      closingBalanceCents: input.parsed.closingBalanceCents, closingBalanceOn: input.parsed.closingBalanceOn, rows,
    });
    // Like Rails: newer rules also clean up older Uncategorized rows.
    const recategorized = await this.applyCategories(recategorizeUncategorized(await this.transactions(), await this.rules()));
    return { statementId, recategorized };
  }

  /**
   * Writes one statement and all its rows atomically: rows go to `import_staging_rows` first
   * (invisible to every reader), then a single INSERT of the statement fires the
   * `statements_commit_staged` trigger (migration 0004), which moves exactly
   * `transaction_count` rows into `transactions` or aborts the whole INSERT. A failure or crash at
   * any point leaves no statement and no transactions; leftover staging rows are cleared next time.
   */
  private async commitStaged(input: {
    filename: string; currency: string; sha256: string; sourceSha256: string; batchId: string; closingBalanceCents: number | null; closingBalanceOn: string | null;
    rows: PlannedRow[]; account?: PlannedStatement["account"]; format?: string; openingBalanceCents?: number | null; openingBalanceOn?: string | null; report?: ImportReport;
  }): Promise<number> {
    const stamp = now();
    // Staging rows older than an hour belong to an import that never finished.
    await this.db.execute("DELETE FROM import_staging_rows WHERE staging_key = $1 OR staged_at < $2", [input.sha256, new Date(Date.now() - 3_600_000).toISOString()]);
    try {
      const columns = 22;
      for (let start = 0; start < input.rows.length; start += 50) {
        const batch = input.rows.slice(start, start + 50);
        const params: unknown[] = [];
        const values = batch.map((row, offset) => {
          const base = params.length;
          params.push(input.sha256, start + offset, row.bookedOn, row.description, row.amountCents, row.category, row.taxReview ? 1 : 0, row.postedOn, row.normalizedMerchant,
            row.currency, row.direction, row.balanceCents, row.bankReference, row.accountKey, row.categorySource, row.pending ? 1 : 0, row.kindHints || null, row.sourceRef,
            row.confidence, row.validationStatus, row.raw, stamp);
          return `(${Array.from({ length: columns }, (_, i) => `$${base + i + 1}`).join(", ")})`;
        });
        await this.db.execute(
          `INSERT INTO import_staging_rows (staging_key, position, booked_on, description, amount_cents, category, tax_review, posted_on, normalized_merchant, currency, direction,
            balance_cents, bank_reference, account_key, category_source, pending, kind_hints, source_ref, parse_confidence, validation_status, source_raw, staged_at) VALUES ${values.join(", ")}`,
          params,
        );
      }
      const result = await this.db.execute(
        `INSERT INTO statements (filename, currency, sha256, transaction_count, closing_balance_cents, closing_balance_on, imported_at, import_batch_id, source_sha256, source_format,
          account_key, institution, account_last4, account_kind, opening_balance_cents, opening_balance_on, import_report) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)`,
        [input.filename, input.currency, input.sha256, input.rows.length, input.closingBalanceCents, input.closingBalanceOn, stamp, input.batchId, input.sourceSha256,
          input.format ?? null, input.account?.key ?? null, input.account?.institution ?? null, input.account?.last4 ?? null, input.account?.kind ?? "unknown",
          input.openingBalanceCents ?? null, input.openingBalanceOn ?? null, input.report ? JSON.stringify(input.report) : null],
      );
      return Number(result.lastInsertId);
    } catch (error) {
      await this.db.execute("DELETE FROM import_staging_rows WHERE staging_key = $1", [input.sha256]).catch(() => undefined);
      throw error;
    }
  }

  /**
   * Commits a confirmed universal-import plan: one statement per account, each atomic. All
   * statements of one file share `batchId`, so the whole import can be reversed together.
   * If a later account fails, the earlier ones of the same batch are removed again.
   */
  async commitImport(plan: readonly PlannedStatement[], hashes: readonly string[]): Promise<{ batchId: string; statementIds: number[]; transactions: number; recategorized: number }> {
    const deviceCurrency = await this.currency();
    for (const statement of plan) {
      if (!(CURRENCIES as readonly string[]).includes(statement.currency)) throw new StoreError("unsupported_currency", "That currency is not supported.");
      if (deviceCurrency && deviceCurrency !== statement.currency) {
        throw new StoreError("currency_mismatch", `This device keeps statements in ${deviceCurrency}. Delete local data to switch currency.`, { currency: deviceCurrency });
      }
    }
    const fileHashes = await this.importedFileHashes();
    if (plan.some((statement) => fileHashes.has(statement.sourceSha256)) || hashes.some((hash) => fileHashes.has(hash))) {
      throw new StoreError("statement_duplicate", "This statement was already imported.");
    }
    const batchId = randomId();
    const statementIds: number[] = [];
    try {
      for (const [index, statement] of plan.entries()) {
        statementIds.push(await this.commitStaged({
          filename: statement.filename, currency: statement.currency, sha256: hashes[index], sourceSha256: statement.sourceSha256, batchId, rows: statement.rows,
          closingBalanceCents: statement.closingBalanceCents, closingBalanceOn: statement.closingBalanceOn, account: statement.account, format: statement.format,
          openingBalanceCents: statement.openingBalanceCents, openingBalanceOn: statement.openingBalanceOn, report: statement.report,
        }));
      }
    } catch (error) {
      for (const id of statementIds) {
        await this.db.execute("DELETE FROM transactions WHERE statement_id = $1", [id]);
        await this.db.execute("DELETE FROM statements WHERE id = $1", [id]);
      }
      if ((await this.db.select<Row>("SELECT 1 FROM statements LIMIT 1")).length === 0) await this.db.execute("DELETE FROM settings WHERE key = $1", ["currency"]);
      throw error;
    }
    const recategorized = await this.applyCategories(recategorizeUncategorized(await this.transactions(), await this.rules()));
    return { batchId, statementIds, transactions: plan.reduce((sum, statement) => sum + statement.rows.length, 0), recategorized };
  }

  /** File hashes already imported (the original file's hash, also for multi-account files). */
  async importedFileHashes(): Promise<Set<string>> {
    const rows = await this.db.select<Row>("SELECT sha256, source_sha256 FROM statements");
    return new Set(rows.flatMap((row) => [String(row.sha256), ...(row.source_sha256 ? [String(row.source_sha256)] : [])]));
  }

  /** What duplicate detection compares against. */
  async dedupeIndex(): Promise<ExistingTransaction[]> {
    const rows = await this.db.select<Row>("SELECT id, booked_on, amount_cents, description, account_key, bank_reference FROM transactions");
    return rows.map((row) => ({
      id: Number(row.id), bookedOn: String(row.booked_on), amountCents: Number(row.amount_cents), description: String(row.description),
      accountKey: (row.account_key as string | null) ?? null, bankReference: (row.bank_reference as string | null) ?? null,
    }));
  }

  /** Imports on this device, newest first, with their reports. Legacy imports have no report. */
  async importHistory(): Promise<Array<{ batchId: string | null; statementIds: number[]; filename: string; importedAt: string; format: string | null; transactionCount: number; accounts: string[]; reports: ImportReport[]; source: "local" | "web" }>> {
    const rows = await this.db.select<Row>("SELECT * FROM statements ORDER BY imported_at DESC, id DESC");
    const result: Awaited<ReturnType<FinanceStore["importHistory"]>> = [];
    const groups = new Map<string, (typeof result)[number]>();
    for (const row of rows) {
      const batch = (row.import_batch_id as string | null) ?? null;
      const key = batch ?? `statement:${row.id}`;
      let entry = groups.get(key);
      if (!entry) {
        entry = { batchId: batch, statementIds: [], filename: String(row.filename), importedAt: String(row.imported_at), format: (row.source_format as string | null) ?? null,
          transactionCount: 0, accounts: [], reports: [], source: row.source === "web" ? "web" : "local" };
        groups.set(key, entry);
        result.push(entry);
      }
      entry.statementIds.push(Number(row.id));
      entry.transactionCount += Number(row.transaction_count);
      if (row.account_last4) entry.accounts.push(`${row.institution ? `${String(row.institution)} ` : ""}…${String(row.account_last4)}`);
      if (row.import_report) {
        try {
          entry.reports.push(JSON.parse(String(row.import_report)) as ImportReport);
        } catch {
          // A damaged report is ignored; the transactions are unaffected.
        }
      }
    }
    return result;
  }

  /** Reverses one import: removes exactly its statements and their transactions, nothing else. */
  async reverseImport(statementIds: readonly number[]): Promise<number> {
    let removed = 0;
    for (const id of statementIds) {
      const [count] = await this.db.select<Row>("SELECT COUNT(*) AS n FROM transactions WHERE statement_id = $1", [id]);
      await this.removeStatement(id);
      removed += Number(count?.n ?? 0);
    }
    return removed;
  }

  async templates(): Promise<ImportTemplate[]> {
    const rows = await this.db.select<Row>("SELECT body FROM import_templates ORDER BY name COLLATE NOCASE");
    return rows.flatMap((row) => {
      try {
        return [JSON.parse(String(row.body)) as ImportTemplate];
      } catch {
        return [];
      }
    });
  }

  async saveTemplate(template: ImportTemplate): Promise<void> {
    const name = normalizeDatabaseName(template.name).slice(0, 80);
    if (!name) throw new StoreError("invalid_name", "Give this template a name.");
    const body = JSON.stringify({ ...template, name });
    await this.db.execute(
      `INSERT INTO import_templates (id, name, institution, fingerprint, body, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6, $6)
       ON CONFLICT (id) DO UPDATE SET name = excluded.name, institution = excluded.institution, fingerprint = excluded.fingerprint, body = excluded.body, updated_at = excluded.updated_at`,
      [template.id, name, template.institution, template.fingerprint, body, now()],
    );
  }

  async deleteTemplate(id: string): Promise<void> {
    await this.db.execute("DELETE FROM import_templates WHERE id = $1", [id]);
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
    await this.db.execute("UPDATE transactions SET locally_modified = 1, category_source = 'user' WHERE id = $1", [id]);
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
   * Permanently removes every statement, transaction and rule in this database. The only
   * settings kept are whether website download is on and the database's name
   * (preferences, not financial data), unless `forgetName` clears those too.
   */
  async deleteAllData(options: { forgetName?: boolean } = {}): Promise<void> {
    for (const table of ["transactions", "statements", "merchant_rules", "custom_categories", "import_staging_rows", "import_templates"]) await this.db.execute(`DELETE FROM ${table}`);
    if (options.forgetName) await this.db.execute("DELETE FROM settings");
    else await this.db.execute("DELETE FROM settings WHERE key NOT IN ($1, $2)", ["web_sync_enabled", "database_name"]);
    // Reclaim freed pages so deleted rows do not linger in the database file.
    try {
      await this.db.execute("VACUUM");
    } catch {
      // Some drivers refuse VACUUM while other connections are open; the rows are already gone.
    }
  }

  /** The name the person gave this device's database, or null before it has been named. */
  async databaseName(): Promise<string | null> {
    const [row] = await this.db.select<Row>("SELECT value FROM settings WHERE key = $1", ["database_name"]);
    return row ? String(row.value) : null;
  }

  /** Names (or renames) this device's database. Returns the name as stored. */
  async setDatabaseName(name: string): Promise<string> {
    const clean = normalizeDatabaseName(name);
    if (!clean) throw new StoreError("invalid_name", "Give this database a name.");
    await this.setSetting("database_name", clean);
    return clean;
  }

  /**
   * This database's random identifier for the website's "Local databases" cards: made the first
   * time it is needed, kept across renames, and gone when the database is deleted. It is not
   * derived from a path, the device or anything personal.
   */
  async reportId(): Promise<string> {
    const existing = await this.peekReportId();
    if (existing) return existing;
    const id = randomId();
    await this.setSetting("report_id", id);
    return id;
  }

  /** The identifier if one was ever made (so deleting a database that was never reported sends nothing). */
  async peekReportId(): Promise<string | null> {
    const [row] = await this.db.select<Row>("SELECT value FROM settings WHERE key = $1", ["report_id"]);
    return row ? String(row.value) : null;
  }

  /**
   * The basic facts about this database that may be shown on the website: its name, size and
   * counts. Counts and dates only; no statement names, descriptions, amounts or categories.
   */
  async reportSummary(): Promise<{ name: string | null; sizeBytes: number; statements: number; transactions: number; rules: number; periodStart: string | null; periodEnd: string | null; modifiedAt: string | null }> {
    const [info, counts, modifiedAt, name] = await Promise.all([
      this.databaseInfo(),
      this.db.select<Row>("SELECT (SELECT COUNT(*) FROM statements) AS statements, (SELECT COUNT(*) FROM transactions) AS transactions, (SELECT COUNT(*) FROM merchant_rules) AS rules"),
      this.lastChanged(),
      this.databaseName(),
    ]);
    return {
      name, sizeBytes: info.sizeBytes, statements: Number(counts[0]?.statements ?? 0), transactions: Number(counts[0]?.transactions ?? 0),
      rules: Number(counts[0]?.rules ?? 0), periodStart: info.periodStart, periodEnd: info.periodEnd, modifiedAt,
    };
  }

  /** When an explicit "Sync Now" last finished for this database (never set by metadata reporting or the automatic website download). */
  async lastSyncedAt(): Promise<string | null> {
    const [row] = await this.db.select<Row>("SELECT value FROM settings WHERE key = $1", ["last_synced_at"]);
    return row ? String(row.value) : null;
  }

  async markSynced(): Promise<void> {
    await this.setSetting("last_synced_at", now());
  }

  /** Size and coverage of this device's database. */
  async databaseInfo(): Promise<{ sizeBytes: number; periodStart: string | null; periodEnd: string | null }> {
    const [pages] = await this.db.select<Row>("SELECT page_count * page_size AS bytes FROM pragma_page_count(), pragma_page_size()");
    const [range] = await this.db.select<Row>("SELECT MIN(booked_on) AS first, MAX(booked_on) AS last FROM transactions");
    return { sizeBytes: Number(pages?.bytes ?? 0), periodStart: (range?.first as string | null) ?? null, periodEnd: (range?.last as string | null) ?? null };
  }

  /** When anything in this database last changed (a transaction edit or a statement import). */
  async lastChanged(): Promise<string | null> {
    const [row] = await this.db.select<Row>(`SELECT MAX(v) AS last FROM (
      SELECT MAX(updated_at) AS v FROM transactions UNION ALL SELECT MAX(imported_at) FROM statements UNION ALL SELECT MAX(updated_at) FROM merchant_rules)`);
    return (row?.last as string | null) ?? null;
  }

  /** Everything in this database, to copy into another one. Statements keep their file hash. */
  async exportData(): Promise<TransferData> {
    const statements = await this.statements();
    const transactions = await this.transactions();
    const byStatement = new Map<number, TransferStatement["rows"]>();
    for (const t of [...transactions].reverse()) {
      const rows = byStatement.get(t.statementId) ?? [];
      rows.push({ bookedOn: t.bookedOn, description: t.description, amountCents: t.amountCents, category: t.category, taxReview: t.taxReview, excluded: t.excluded });
      byStatement.set(t.statementId, rows);
    }
    return {
      statements: statements.map((s) => ({
        filename: s.filename, currency: s.currency, sha256: s.sha256, closingBalanceCents: s.closingBalanceCents,
        closingBalanceOn: s.closingBalanceOn, importedAt: s.importedAt, rows: byStatement.get(s.id) ?? [],
      })),
      rules: await this.rules(),
      categories: await this.customCategories(),
    };
  }

  /**
   * Copies another database's data into this one. Statements this database already has
   * (same file hash) are left alone, so running it twice changes nothing; rules this
   * database already has win. Copies become this database's own statements. One database
   * keeps one currency, like an import.
   */
  async mergeData(data: TransferData): Promise<MergeResult> {
    const result: MergeResult = { statementsAdded: 0, transactionsAdded: 0, rulesAdded: 0, skipped: 0 };
    const known = new Set((await this.db.select<Row>("SELECT sha256 FROM statements")).map((row) => String(row.sha256)));
    const fresh = data.statements.filter((statement) => {
      if (known.has(statement.sha256)) result.skipped += 1;
      return !known.has(statement.sha256);
    });
    const currency = (await this.currency()) ?? fresh[0]?.currency ?? null;
    const wrong = fresh.find((statement) => statement.currency !== currency);
    if (currency && wrong) throw new StoreError("currency_mismatch", `This database keeps statements in ${currency}.`, { currency, web: wrong.currency });
    const stamp = now();
    const skipped = await this.skippedHashes();
    const custom = await this.ensureCategories([...(data.categories ?? []), ...fresh.flatMap((statement) => statement.rows.map((row) => row.category)), ...data.rules.map((rule) => rule.category)]);
    for (const statement of fresh) {
      const inserted = await this.db.execute(
        "INSERT INTO statements (filename, currency, sha256, transaction_count, closing_balance_cents, closing_balance_on, imported_at) VALUES ($1, $2, $3, $4, $5, $6, $7)",
        [statement.filename, statement.currency, statement.sha256, statement.rows.length, statement.closingBalanceCents, statement.closingBalanceOn, statement.importedAt || stamp],
      );
      const statementId = Number(inserted.lastInsertId);
      try {
        for (let start = 0; start < statement.rows.length; start += 100) {
          const batch = statement.rows.slice(start, start + 100);
          const params: unknown[] = [];
          const values = batch.map((row) => {
            const base = params.length;
            params.push(statementId, row.bookedOn, row.description, row.amountCents, FinanceStore.knownCategory(row.category, custom), row.taxReview ? 1 : 0, row.excluded ? 1 : 0, stamp);
            return `(${Array.from({ length: 8 }, (_, i) => `$${base + i + 1}`).join(", ")})`;
          });
          await this.db.execute(
            `INSERT INTO transactions (statement_id, booked_on, description, amount_cents, category, tax_review, excluded, updated_at) VALUES ${values.join(", ")}`,
            params,
          );
        }
      } catch (error) {
        await this.db.execute("DELETE FROM transactions WHERE statement_id = $1", [statementId]);
        await this.db.execute("DELETE FROM statements WHERE id = $1", [statementId]);
        throw error;
      }
      skipped.delete(statement.sha256);
      result.statementsAdded += 1;
      result.transactionsAdded += statement.rows.length;
    }
    if (result.statementsAdded > 0) {
      await this.setSetting("web_sync_skip", JSON.stringify([...skipped]));
      if (!(await this.currency()) && currency) await this.setSetting("currency", currency);
    }
    for (const rule of data.rules) {
      if (FinanceStore.knownCategory(rule.category, custom) !== rule.category) continue;
      const added = await this.db.execute(
        "INSERT INTO merchant_rules (merchant_key, income, category, updated_at) VALUES ($1, $2, $3, $4) ON CONFLICT (merchant_key, income) DO NOTHING",
        [rule.merchantKey, rule.income ? 1 : 0, rule.category, stamp],
      );
      result.rulesAdded += added.rowsAffected;
    }
    return result;
  }

  /** Every statement on this device with its transaction count and date range. */
  async statementInventory(): Promise<StatementInventoryItem[]> {
    const rows = await this.db.select<Row>(`SELECT s.id, s.filename, s.sha256, s.source, COUNT(t.id) AS transactions, MIN(t.booked_on) AS first, MAX(t.booked_on) AS last
      FROM statements s LEFT JOIN transactions t ON t.statement_id = s.id GROUP BY s.id ORDER BY last DESC, s.id DESC`);
    return rows.map((row) => ({
      id: Number(row.id), filename: String(row.filename), sha256: String(row.sha256), source: row.source === "web" ? "web" : "local",
      transactionCount: Number(row.transactions), periodStart: (row.first as string | null) ?? null, periodEnd: (row.last as string | null) ?? null,
    }));
  }

  /**
   * Removes one statement and its transactions from this device. If the same statement is
   * in the cloud, it is remembered as "not on this device" so downloads don't bring it back.
   */
  async removeStatement(id: number): Promise<void> {
    const [row] = await this.db.select<Row>("SELECT sha256 FROM statements WHERE id = $1", [id]);
    if (!row) throw new StoreError("not_found", "Statement not found.");
    await this.db.execute("DELETE FROM transactions WHERE statement_id = $1", [id]);
    await this.db.execute("DELETE FROM statements WHERE id = $1", [id]);
    const skipped = await this.skippedHashes();
    skipped.add(String(row.sha256));
    await this.setSetting("web_sync_skip", JSON.stringify([...skipped]));
    if ((await this.db.select<Row>("SELECT 1 FROM statements LIMIT 1")).length === 0) {
      await this.db.execute("DELETE FROM settings WHERE key = $1", ["currency"]);
    }
  }

  /** Statements (by file hash) the person chose not to keep on this device. */
  async skippedHashes(): Promise<Set<string>> {
    const [row] = await this.db.select<Row>("SELECT value FROM settings WHERE key = $1", ["web_sync_skip"]);
    try {
      return new Set(row ? (JSON.parse(String(row.value)) as string[]) : []);
    } catch {
      return new Set();
    }
  }

  /** Allows a cloud statement to be downloaded to this device again. */
  async allowDownload(sha256: string): Promise<void> {
    const skipped = await this.skippedHashes();
    skipped.delete(sha256);
    await this.setSetting("web_sync_skip", JSON.stringify([...skipped]));
    await this.db.execute("DELETE FROM settings WHERE key = $1", ["web_sync_version"]);
  }

  /** What is stored on this device, split by where it came from. */
  async localSummary(): Promise<LocalSummary> {
    const [counts] = await this.db.select<Row>(`SELECT
      (SELECT COUNT(*) FROM statements WHERE source = 'local') AS local_statements,
      (SELECT COUNT(*) FROM statements WHERE source = 'web') AS web_statements,
      (SELECT COUNT(*) FROM transactions WHERE remote_id IS NULL) AS local_transactions,
      (SELECT COUNT(*) FROM transactions WHERE remote_id IS NOT NULL) AS web_transactions,
      (SELECT COUNT(*) FROM merchant_rules) AS rules`);
    return {
      localStatements: Number(counts.local_statements), webStatements: Number(counts.web_statements),
      localTransactions: Number(counts.local_transactions), webTransactions: Number(counts.web_transactions),
      rules: Number(counts.rules), currency: await this.currency(),
    };
  }

  /**
   * After the cloud copy is deleted but this device should keep its data: website copies
   * become ordinary local statements, so a later download no longer removes them.
   */
  async detachWebCopies(): Promise<void> {
    await this.db.execute("UPDATE transactions SET remote_id = NULL WHERE remote_id IS NOT NULL");
    await this.db.execute("UPDATE statements SET source = 'local', remote_id = NULL WHERE source = 'web'");
    await this.db.execute("DELETE FROM settings WHERE key = $1", ["web_sync_version"]);
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
    const custom = await this.ensureCategories([...(web.categories ?? []), ...web.transactions.map((transaction) => transaction.category), ...web.rules.map((rule) => rule.category)]);

    // Statements.
    const localRows = await this.db.select<Row>("SELECT id, sha256, source, remote_id FROM statements");
    const localHashes = new Set(localRows.filter((row) => row.source !== "web").map((row) => String(row.sha256)));
    const skipped = await this.skippedHashes();
    const copies = new Map(localRows.filter((row) => row.source === "web").map((row) => [Number(row.remote_id), Number(row.id)]));
    const statementIdFor = new Map<number, number>();
    for (const statement of web.statements) {
      if (skipped.has(statement.sha256)) continue; // the person removed it from this device
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
        inserts.push([statementId, transaction.bookedOn, transaction.description, transaction.amountCents, FinanceStore.knownCategory(transaction.category, custom), transaction.taxReview ? 1 : 0, transaction.excluded ? 1 : 0, stamp, transaction.remoteId]);
        continue;
      }
      const keepLocal = Number(row.locally_modified) === 1;
      const next = {
        statement_id: statementId, booked_on: transaction.bookedOn, description: transaction.description, amount_cents: transaction.amountCents,
        category: keepLocal ? String(row.category) : FinanceStore.knownCategory(transaction.category, custom),
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
      if (FinanceStore.knownCategory(rule.category, custom) !== rule.category) continue;
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
