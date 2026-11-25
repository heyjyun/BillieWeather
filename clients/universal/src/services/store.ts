// All reads and writes of local financial data. Talks only to the on-device SQLite
// database through `SqlDriver` (Tauri's SQL plugin in the app, sql.js in tests and the
// browser preview). Nothing here touches the network.
import type { Category, Currency, MerchantRule, ParsedStatement, Statement, Transaction } from "@billie/shared-types";
import { CURRENCIES } from "@billie/shared-types";
import { accountKey, accountTypeFromLegacy, isAccountType, kindForCategorized, legacyKind, isTransactionKind, type AccountKind, type AccountRef, type AccountType } from "@billie/finance-core";
import { aiGroups, Categorizer, categoryNameProblem, CUSTOM_CATEGORY_MAX, isBuiltInCategory, merchantKey, normalizeCategoryName, normalizeRegion, normalizeRegionSource, parseDetection, recategorizeUncategorized, serializeDetection, type RegionDetection, type RegionSource, ruleFor, titleizeMerchant, transactionsMatchingRule, type AiGroup, type CategoryNameProblem, type ExistingTransaction, type ImportReport, type ImportTemplate, type PlannedRow, type PlannedStatement } from "@billie/finance-core";
import { randomId } from "./ids";
import { LedgerStore, MANUAL_CONTAINER_SHA } from "./ledger";

export interface SqlStatement {
  sql: string;
  params?: unknown[];
}

export interface SqlDriver {
  execute(sql: string, params?: unknown[]): Promise<{ rowsAffected: number; lastInsertId?: number }>;
  select<T>(sql: string, params?: unknown[]): Promise<T[]>;
  /**
   * Runs the statements in ONE database transaction on one connection: all of them apply or none,
   * also when the app is killed half-way. A later statement can use `last_insert_rowid()`.
   * Every operation that changes more than one row set of financial data goes through this.
   */
  transaction(statements: readonly SqlStatement[]): Promise<Array<{ rowsAffected: number; lastInsertId?: number }>>;
  /** Answers the queries from one read transaction: every result describes the same instant. */
  snapshot<T>(queries: readonly SqlStatement[]): Promise<T[][]>;
}

export type StoreErrorCode = "statement_duplicate" | "currency_mismatch" | "unsupported_currency" | "not_found" | "invalid_name" | "invalid_category" | "too_many_categories" | "invalid_region";

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

/** How an import's region was decided and what detection found (finance-core regionDetect.ts). */
export interface RegionMeta {
  /** Defaults to "user" when a region is given, null otherwise. */
  source?: RegionSource | null;
  detection?: RegionDetection | null;
}

/** The source stored with a region: none without a region; a region without a source was selected by a person. */
const regionSourceFor = (region: string | null, source: RegionSource | null | undefined): RegionSource | null => (region ? source ?? "user" : null);
const now = () => new Date().toISOString();

const toStatement = (row: Row): Statement => ({
  id: Number(row.id), filename: String(row.filename), currency: row.currency as Currency, sha256: String(row.sha256),
  transactionCount: Number(row.transaction_count),
  closingBalanceCents: row.closing_balance_cents === null ? null : Number(row.closing_balance_cents),
  closingBalanceOn: (row.closing_balance_on as string | null) ?? null, importedAt: String(row.imported_at),
  source: row.source === "web" ? "web" : "local", region: normalizeRegion(row.region),
});
const parseList = (value: unknown): string[] => {
  try {
    const parsed = JSON.parse(String(value ?? "[]")) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
};
const toTransaction = (row: Row): Transaction => ({
  id: Number(row.id), statementId: Number(row.statement_id), bookedOn: String(row.booked_on), description: String(row.description),
  amountCents: Number(row.amount_cents), category: row.category as Category, taxReview: Number(row.tax_review) === 1, excluded: Number(row.excluded) === 1,
  ...(row.kind !== undefined ? {
    kind: isTransactionKind(row.kind) ? row.kind : legacyKind({ amountMinor: Number(row.amount_cents), category: String(row.category) }),
    accountId: row.account_id === null || row.account_id === undefined ? null : Number(row.account_id),
    originalDescription: String(row.original_description ?? row.description), origin: String(row.entry_origin ?? "import"),
    merchant: (row.merchant_name as string | null | undefined) ?? null, project: (row.project_name as string | null | undefined) ?? null,
    tags: row.tag_names ? String(row.tag_names).split("\u001f") : [], note: (row.note as string | null | undefined) ?? null, time: (row.occurred_at_time as string | null | undefined) ?? null,
    lockedFields: parseList(row.user_locked_fields), categorySource: String(row.category_source ?? "legacy"),
  } : {}),
});

/** Live (not trashed) entries with their dimensions, newest first. */
const TRANSACTIONS_SQL = `SELECT t.*, m.name AS merchant_name, p.name AS project_name,
  (SELECT group_concat(g.name, char(31)) FROM transaction_tags tt JOIN tags g ON g.id = tt.tag_id WHERE tt.transaction_id = t.id) AS tag_names
  FROM transactions t LEFT JOIN merchants m ON m.id = t.merchant_id LEFT JOIN projects p ON p.id = t.project_id
  WHERE t.deleted_at IS NULL ORDER BY t.booked_on DESC, t.id DESC`;
/** Imported statements only: the hidden manual-entries container (ledger.ts) is not a statement to people. */
const REAL_STATEMENTS = "COALESCE(source_format, '') <> 'manual'";

/** Financial data downloaded (read-only) from the person's BillieWeather web account. */
export interface WebData {
  currency: Currency | null;
  statements: Array<{ remoteId: number; filename: string; currency: Currency; sha256: string; transactionCount: number; closingBalanceCents: number | null; closingBalanceOn: string | null; importedAt: string }>;
  transactions: Array<{ remoteId: number; remoteStatementId: number; bookedOn: string; description: string; amountCents: number; category: Category; taxReview: boolean; excluded: boolean; kind?: string; originalDescription?: string }>;
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
  /** Optional region; copied between local databases only (cloudUpload.ts never sends it). */
  region?: string | null;
  /**
   * The account the statement belongs to, when the import identified one (bank, last four digits,
   * kind; never a full number). It travels with the statement so the receiving side compares
   * duplicates per account and reads money in on a card as a refund or repayment, not income.
   */
  account?: { institution: string | null; last4: string; kind: string } | null;
  rows: Array<{ bookedOn: string; description: string; amountCents: number; category: Category; taxReview: boolean; excluded: boolean; kind?: string; originalDescription?: string }>;
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

/** A transaction's editable flags exactly as stored (for undoing command changes). */
export interface TransactionFlags {
  id: number;
  category: string;
  categorySource: string;
  taxReview: boolean;
  excluded: boolean;
  locallyModified: boolean;
  updatedAt: string;
}

export interface WebSyncSettings {
  enabled: boolean;
  version: string | null;
  checkedAt: string | null;
}

export class FinanceStore {
  /** Manual bookkeeping on the same database (accounts, entries, links, budgets, …). */
  readonly ledger: LedgerStore;

  constructor(private db: SqlDriver) {
    this.ledger = new LedgerStore(db);
  }

  /** The database connection (for backups and "Organize with AI"; still this device only). */
  get sql(): SqlDriver {
    return this.db;
  }

  /**
   * Which signed-in account owns this database (`id:<uuid>` from the server, or `email:<sha256>`
   * from older servers). Null for a database no account has opened since owners were recorded.
   */
  async owner(): Promise<string | null> {
    const [row] = await this.db.select<Row>("SELECT value FROM settings WHERE key = $1", ["owner_account_id"]);
    return row ? String(row.value) : null;
  }

  /** Records the owner. Only ever called for a database without one, or to upgrade `email:` to `id:` for the same account. */
  async setOwner(owner: string): Promise<void> {
    await this.setSetting("owner_account_id", owner);
  }

  /** This book's stable id (a database file is one book). Made on first use. */
  async bookUuid(): Promise<string> {
    const [row] = await this.db.select<Row>("SELECT value FROM settings WHERE key = $1", ["book_uuid"]);
    if (row) return String(row.value);
    const id = randomId();
    await this.setSetting("book_uuid", id);
    return id;
  }

  /** The currency is fixed by the first import, like the Rails profile. */
  async currency(): Promise<Currency | null> {
    const rows = await this.db.select<Row>("SELECT value FROM settings WHERE key = $1", ["currency"]);
    return (rows[0]?.value as Currency | undefined) ?? null;
  }

  async statements(): Promise<Statement[]> {
    return (await this.db.select<Row>(`SELECT * FROM statements WHERE ${REAL_STATEMENTS} ORDER BY id`)).map(toStatement);
  }

  /** Every live entry (imported and manual). Entries in the trash are left out. */
  async transactions(): Promise<Transaction[]> {
    return (await this.db.select<Row>(TRANSACTIONS_SQL)).map(toTransaction);
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
    // A category is a name held by several tables: all of them change together or none does.
    await this.db.transaction([
      { sql: "UPDATE custom_categories SET name = $1 WHERE name = $2", params: [clean, from] },
      { sql: "UPDATE transactions SET category = $1, locally_modified = 1, updated_at = $2 WHERE category = $3", params: [clean, stamp, from] },
      { sql: "UPDATE merchant_rules SET category = $1, updated_at = $2 WHERE category = $3", params: [clean, stamp, from] },
      ...this.ledger.renameCategoryMetaStatements(from, clean),
      this.ledger.auditStatement({ action: "update", subjectType: "category", subjectId: clean, changes: { name: [from, clean] } }),
    ]);
    return clean;
  }

  /** Deletes a custom category: its transactions become Uncategorized, its rules are forgotten. Returns how many transactions moved. */
  async deleteCategory(name: string, moveTo: Category = "Uncategorized"): Promise<number> {
    const [row] = await this.db.select<Row>("SELECT name FROM custom_categories WHERE name = $1", [name]);
    if (!row) throw new StoreError("not_found", "Category not found.");
    const target = moveTo.toLowerCase() === name.toLowerCase() ? "Uncategorized" : moveTo;
    if (!isBuiltInCategory(target) && !(await this.customCategories()).includes(target)) throw new StoreError("invalid_category", "Unknown category.");
    // Entries are moved, never deleted (I-9); the ids moved are kept in the operation log.
    const ids = (await this.db.select<Row>("SELECT id FROM transactions WHERE category = $1", [name])).map((item) => Number(item.id));
    const [moved] = await this.db.transaction([
      { sql: "UPDATE transactions SET category = $1, locally_modified = 1, updated_at = $2 WHERE category = $3", params: [target, now(), name] },
      { sql: "DELETE FROM merchant_rules WHERE category = $1", params: [name] },
      { sql: "DELETE FROM custom_categories WHERE name = $1", params: [name] },
      ...this.ledger.deleteCategoryMetaStatements(name),
      this.ledger.auditStatement({ action: "delete", subjectType: "category", subjectId: name, summary: `${ids.length} entries → ${target}`, changes: { entries: [ids, target] } }),
    ]);
    return moved.rowsAffected;
  }

  /** Merges one custom category into another: entries and rules move, the first category is removed. */
  async mergeCategory(from: string, into: Category): Promise<number> {
    if (from.toLowerCase() === into.toLowerCase()) return 0;
    const ids = (await this.db.select<Row>("SELECT id FROM transactions WHERE category = $1", [from])).map((item) => Number(item.id));
    await this.db.execute("UPDATE merchant_rules SET category = $1, updated_at = $2 WHERE category = $3 AND NOT EXISTS (SELECT 1 FROM merchant_rules r WHERE r.merchant_key = merchant_rules.merchant_key AND r.income = merchant_rules.income AND r.category = $4)",
      [into, now(), from, into]);
    const moved = await this.deleteCategory(from, into);
    await this.ledger.audit({ action: "merge", subjectType: "category", subjectId: into, summary: `${from} → ${into}`, changes: { entries: [ids, into] } });
    return moved;
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
    return (await this.applyAiCategoriesBatch(groups, assignments)).changed;
  }

  /**
   * Applies AI category suggestions as ONE audited, undoable batch (actor "ai", action "ai_apply"):
   * every changed row gets an operation-log event with its previous values, all in one database
   * transaction (all or nothing). Only rows still Uncategorized and not locked by a person change.
   * Undo (Activity › Undo) skips a row a person changed since (the step carries `expect`).
   * Returns how many rows changed and the batch id (null when nothing changed).
   */
  async applyAiCategoriesBatch(groups: readonly AiGroup[], assignments: ReadonlyArray<{ key: string; category: string }>): Promise<{ changed: number; batchId: string | null }> {
    const custom = new Set(await this.customCategories());
    const byKey = new Map(groups.map((group) => [group.key, group]));
    const stamp = now();
    const batchId = randomId();
    const statements: SqlStatement[] = [];
    let changed = 0;
    for (const { key, category } of assignments) {
      const group = byKey.get(key);
      if (!group || category === "Uncategorized" || category === "Transfers" || !(isBuiltInCategory(category) || custom.has(category))) continue;
      if (category === "Income" && group.direction !== "in") continue;
      byKey.delete(key);
      for (let start = 0; start < group.ids.length; start += 100) {
        const ids = group.ids.slice(start, start + 100);
        const rows = await this.db.select<Record<string, unknown>>(
          `SELECT id, uuid, category, category_source, category_confidence, category_model, tax_review FROM transactions
            WHERE category = 'Uncategorized' AND deleted_at IS NULL AND COALESCE(user_locked_fields, '') NOT LIKE '%"category"%' AND id IN (${ids.map(() => "?").join(", ")})`,
          [...ids],
        );
        for (const row of rows) {
          const id = Number(row.id);
          const taxReview = category === "Business" ? 1 : Number(row.tax_review ?? 0);
          // Same eligibility in the UPDATE: a row that changed after the SELECT is left alone.
          statements.push({
            sql: `UPDATE transactions SET category = ?, tax_review = ?, category_source = 'ai', updated_at = ?
              WHERE id = ? AND category = 'Uncategorized' AND deleted_at IS NULL AND COALESCE(user_locked_fields, '') NOT LIKE '%"category"%'`,
            params: [category, taxReview, stamp, id],
          });
          statements.push(this.ledger.auditStatement({
            actor: "ai", action: "ai_apply", subjectType: "transaction", subjectId: String(row.uuid), batchId,
            // Only the classification fields: no amounts, dates or descriptions in the log.
            changes: { category: [row.category, category], category_source: [row.category_source, "ai"] },
            undo: [{ op: "set", table: "transactions", id,
              fields: { category: row.category, category_source: row.category_source, category_confidence: row.category_confidence, category_model: row.category_model, tax_review: row.tax_review },
              expect: { category, category_source: "ai" } }],
          }));
          changed += 1;
        }
      }
    }
    if (changed === 0) return { changed: 0, batchId: null };
    statements.push(this.ledger.auditStatement({ actor: "ai", action: "ai_apply", subjectType: "batch", subjectId: batchId, batchId: null, summary: `${changed} categorized` }));
    await this.db.transaction(statements);
    return { changed, batchId };
  }

  /** The rule-based categorizer: remembered rules first, then built-in lists, then the optional region. */
  async categorizer(region?: string | null): Promise<Categorizer> {
    return new Categorizer(await this.rules(), { region });
  }

  /**
   * Saves a parsed statement. The same file (by SHA-256) is never imported twice, and
   * one device keeps one currency. The statement and its rows are one database transaction. `account` is the account the statement names (text PDFs
   * detect it); with an identified account the rows carry its key, so later imports of the same
   * account are compared against them exactly, and kinds follow the account type.
   */
  async importStatement(input: { filename: string; currency: Currency; sha256: string; parsed: ParsedStatement; region?: string | null; regionMeta?: RegionMeta; account?: AccountRef; format?: string }): Promise<{ statementId: number; recategorized: number }> {
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

    const region = normalizeRegion(input.region);
    const incomeCategories = await this.ledger.incomeCategories(await this.customCategories());
    // Rows whose category only the region chose are marked, so a later reclassification can revisit exactly those.
    const regional = region ? await this.categorizer(region) : null;
    const account = input.account?.key ? input.account : undefined;
    const accountType = account ? accountTypeFromLegacy(account.kind, "local") : null;
    const rows: PlannedRow[] = input.parsed.rows.map((row, index) => ({
      bookedOn: row.bookedOn, postedOn: null, description: row.description, normalizedMerchant: titleizeMerchant(merchantKey(row.description)),
      amountCents: row.amountCents, currency: input.currency, direction: row.amountCents < 0 ? "debit" : row.amountCents > 0 ? "credit" : "zero",
      balanceCents: null, bankReference: null, accountKey: account?.key ?? null, category: row.category,
      categorySource: regional && FinanceStore.decidedByRegion(regional, row) ? "region" : "auto", taxReview: row.taxReview, pending: false,
      kindHints: "", kind: kindForCategorized({ amountMinor: row.amountCents, accountType, description: row.description, category: row.category, incomeCategories }),
      sourceRef: `row:${index + 1}`, confidence: 100, validationStatus: "verified", raw: "{}",
    }));
    const results = await this.db.transaction(await this.stagedStatements({
      filename: input.filename, currency: input.currency, sha256: input.sha256, sourceSha256: input.sha256, batchId: randomId(),
      closingBalanceCents: input.parsed.closingBalanceCents, closingBalanceOn: input.parsed.closingBalanceOn, rows, region, regionMeta: input.regionMeta,
      account, format: input.format,
    }));
    const statementId = Number(results[results.length - 1].lastInsertId);
    // Like Rails: newer rules also clean up older Uncategorized rows.
    const recategorized = await this.applyCategories(recategorizeUncategorized(await this.automaticTransactions(), await this.rules()));
    return { statementId, recategorized };
  }

  /**
   * The statements that write one statement and all its rows: rows go to `import_staging_rows`
   * first (invisible to every reader), then the INSERT of the statement fires the
   * `statements_commit_staged` trigger (migration 0004), which moves exactly `transaction_count`
   * rows into `transactions` or aborts. The caller runs them in one database transaction
   * (`SqlDriver.transaction`), so a failure or crash at any point leaves nothing behind. The last
   * statement is the INSERT of the statement itself (its `lastInsertId` is the statement id).
   */
  private async stagedStatements(input: {
    filename: string; currency: string; sha256: string; sourceSha256: string; batchId: string; closingBalanceCents: number | null; closingBalanceOn: string | null;
    rows: PlannedRow[]; account?: PlannedStatement["account"]; format?: string; openingBalanceCents?: number | null; openingBalanceOn?: string | null; report?: ImportReport;
    region?: string | null;
    regionMeta?: RegionMeta;
  }): Promise<SqlStatement[]> {
    const region = normalizeRegion(input.region);
    const detection = input.regionMeta?.detection ?? null;
    const stamp = now();
    const accountId = await this.ledger.accountForImport({ key: input.account?.key ?? null, institution: input.account?.institution, last4: input.account?.last4, kind: input.account?.kind, currency: input.currency });
    // Rows left by an app version that staged outside a transaction are cleared here.
    const statements: SqlStatement[] = [{ sql: "DELETE FROM import_staging_rows WHERE staging_key = $1 OR staged_at < $2", params: [input.sha256, new Date(Date.now() - 3_600_000).toISOString()] }];
    const columns = 25;
    for (let start = 0; start < input.rows.length; start += 50) {
      const batch = input.rows.slice(start, start + 50);
      const params: unknown[] = [];
      const values = batch.map((row, offset) => {
        const base = params.length;
        params.push(input.sha256, start + offset, row.bookedOn, row.description, row.amountCents, row.category, row.taxReview ? 1 : 0, row.postedOn, row.normalizedMerchant,
          row.currency, row.direction, row.balanceCents, row.bankReference, row.accountKey, row.categorySource, row.pending ? 1 : 0, row.kindHints || null, row.sourceRef,
          row.confidence, row.validationStatus, row.raw, stamp, row.kind, accountId, row.description);
        return `(${Array.from({ length: columns }, (_, i) => `$${base + i + 1}`).join(", ")})`;
      });
      statements.push({
        sql: `INSERT INTO import_staging_rows (staging_key, position, booked_on, description, amount_cents, category, tax_review, posted_on, normalized_merchant, currency, direction,
          balance_cents, bank_reference, account_key, category_source, pending, kind_hints, source_ref, parse_confidence, validation_status, source_raw, staged_at, kind, account_id, original_description) VALUES ${values.join(", ")}`,
        params,
      });
    }
    statements.push({
      sql: `INSERT INTO statements (filename, currency, sha256, transaction_count, closing_balance_cents, closing_balance_on, imported_at, import_batch_id, source_sha256, source_format,
        account_key, institution, account_last4, account_kind, opening_balance_cents, opening_balance_on, import_report, region,
        region_source, detected_region, region_confidence, region_evidence, account_id) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23)`,
      params: [input.filename, input.currency, input.sha256, input.rows.length, input.closingBalanceCents, input.closingBalanceOn, stamp, input.batchId, input.sourceSha256,
        input.format ?? null, input.account?.key ?? null, input.account?.institution ?? null, input.account?.last4 ?? null, input.account?.kind ?? "unknown",
        input.openingBalanceCents ?? null, input.openingBalanceOn ?? null, input.report ? JSON.stringify(input.report) : null, region,
        regionSourceFor(region, input.regionMeta?.source), detection?.detectedRegion ?? null, detection?.confidence ?? null, detection ? serializeDetection(detection) : null, accountId],
    });
    return statements;
  }

  /**
   * Commits a confirmed universal-import plan: one statement per account. Every account of the file
   * is written in ONE database transaction, so a multi-account import appears completely or not at
   * all. All statements of one file share `batchId`, so the whole import can be reversed together.
   */
  async commitImport(plan: readonly PlannedStatement[], hashes: readonly string[], region?: string | null, regionMeta?: RegionMeta): Promise<{ batchId: string; statementIds: number[]; transactions: number; recategorized: number }> {
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
    const statements: SqlStatement[] = [];
    const statementAt: number[] = [];
    for (const [index, statement] of plan.entries()) {
      statements.push(...await this.stagedStatements({
        filename: statement.filename, currency: statement.currency, sha256: hashes[index], sourceSha256: statement.sourceSha256, batchId, rows: statement.rows,
        closingBalanceCents: statement.closingBalanceCents, closingBalanceOn: statement.closingBalanceOn, account: statement.account, format: statement.format,
        openingBalanceCents: statement.openingBalanceCents, openingBalanceOn: statement.openingBalanceOn, report: statement.report, region, regionMeta,
      }));
      statementAt.push(statements.length - 1);
    }
    const results = await this.db.transaction(statements);
    const statementIds = statementAt.map((position) => Number(results[position].lastInsertId));
    const recategorized = await this.applyCategories(recategorizeUncategorized(await this.automaticTransactions(), await this.rules()));
    return { batchId, statementIds, transactions: plan.reduce((sum, statement) => sum + statement.rows.length, 0), recategorized };
  }

  /** File hashes already imported (the original file's hash, also for multi-account files). */
  async importedFileHashes(): Promise<Set<string>> {
    const rows = await this.db.select<Row>(`SELECT sha256, source_sha256 FROM statements WHERE ${REAL_STATEMENTS}`);
    return new Set(rows.flatMap((row) => [String(row.sha256), ...(row.source_sha256 ? [String(row.source_sha256)] : [])]));
  }

  /** What duplicate detection compares against. */
  async dedupeIndex(): Promise<ExistingTransaction[]> {
    const rows = await this.db.select<Row>("SELECT id, booked_on, amount_cents, COALESCE(original_description, description) AS description, account_key, bank_reference FROM transactions WHERE deleted_at IS NULL AND entry_origin <> 'manual'");
    return rows.map((row) => ({
      id: Number(row.id), bookedOn: String(row.booked_on), amountCents: Number(row.amount_cents), description: String(row.description),
      accountKey: (row.account_key as string | null) ?? null, bankReference: (row.bank_reference as string | null) ?? null,
    }));
  }

  /** Imports on this device, newest first, with their reports. Legacy imports have no report. */
  async importHistory(): Promise<Array<{ batchId: string | null; statementIds: number[]; filename: string; importedAt: string; format: string | null; transactionCount: number; accounts: string[]; reports: ImportReport[]; source: "local" | "web"; region: string | null; regionSource: RegionSource | null; detection: RegionDetection }>> {
    const rows = await this.db.select<Row>(`SELECT * FROM statements WHERE ${REAL_STATEMENTS} ORDER BY imported_at DESC, id DESC`);
    const result: Awaited<ReturnType<FinanceStore["importHistory"]>> = [];
    const groups = new Map<string, (typeof result)[number]>();
    for (const row of rows) {
      const batch = (row.import_batch_id as string | null) ?? null;
      const key = batch ?? `statement:${row.id}`;
      let entry = groups.get(key);
      if (!entry) {
        entry = { batchId: batch, statementIds: [], filename: String(row.filename), importedAt: String(row.imported_at), format: (row.source_format as string | null) ?? null,
          transactionCount: 0, accounts: [], reports: [], source: row.source === "web" ? "web" : "local", region: normalizeRegion(row.region),
          regionSource: normalizeRegionSource(row.region_source), detection: parseDetection(row.detected_region, row.region_confidence, row.region_evidence) };
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
    return this.removeStatements(statementIds);
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
    await this.lockCategory([id], category, String(row.category));
    if (!remember) return 0;
    const rule = ruleFor(transaction, category);
    if (!rule) return 0;
    await this.db.execute(
      "INSERT INTO merchant_rules (merchant_key, income, category, updated_at) VALUES ($1, $2, $3, $4) ON CONFLICT (merchant_key, income) DO UPDATE SET category = excluded.category, updated_at = excluded.updated_at",
      [rule.merchantKey, rule.income ? 1 : 0, rule.category, now()],
    );
    return this.applyCategories(transactionsMatchingRule(await this.automaticTransactions(), rule, id).map((match) => ({ id: match.id, category })));
  }

  /**
   * Changes the optional region of statements imported on this device (one import may hold several
   * statements). Metadata only: no transaction, amount, date, currency or category changes here;
   * reclassifying is a separate, explicit step (`reclassifyStatements`). Website copies are refused.
   */
  async setStatementRegion(statementIds: readonly number[], region: string | null, source: RegionSource = "user"): Promise<void> {
    const code = normalizeRegion(region);
    if (region !== null && region !== "" && code === null) throw new StoreError("invalid_region", "Unknown region.");
    for (const id of statementIds) {
      const [row] = await this.db.select<Row>("SELECT source FROM statements WHERE id = $1", [id]);
      if (!row || row.source === "web") throw new StoreError("not_found", "Statement not found.");
    }
    for (const id of statementIds) await this.db.execute("UPDATE statements SET region = $1, region_source = $2 WHERE id = $3", [code, regionSourceFor(code, source), id]);
  }

  /**
   * "Keep my selection" after a region conflict warning: the selected region stays exactly as it
   * is and is marked as confirmed, so the warning is not shown again. Metadata only.
   */
  async keepStatementRegion(statementIds: readonly number[]): Promise<void> {
    for (const id of statementIds) {
      const [row] = await this.db.select<Row>("SELECT source, region FROM statements WHERE id = $1", [id]);
      if (!row || row.source === "web") throw new StoreError("not_found", "Statement not found.");
    }
    for (const id of statementIds) await this.db.execute("UPDATE statements SET region_source = 'user_confirmed' WHERE id = $1 AND region IS NOT NULL", [id]);
  }

  /**
   * Re-runs the rule-based categorizer over these statements with each one's current region, on
   * request. Only rows that automation may still decide are looked at: rows that are Uncategorized
   * or whose category came from a region. A category a person chose (here, in the preview, or by
   * a remembered rule), one from the file, from AI, or from the built-in lists is never changed.
   * Returns how many transactions got a different category.
   */
  async reclassifyStatements(statementIds: readonly number[]): Promise<number> {
    let changed = 0;
    for (const id of statementIds) {
      const [statement] = await this.db.select<Row>("SELECT region, source FROM statements WHERE id = $1", [id]);
      if (!statement || statement.source === "web") throw new StoreError("not_found", "Statement not found.");
      const categorizer = await this.categorizer(normalizeRegion(statement.region));
      const rows = await this.db.select<Row>(
        `SELECT id, description, amount_cents, category, category_source FROM transactions WHERE statement_id = $1 AND locally_modified = 0
          AND category_source NOT IN ('user', 'file') AND (category_source = 'region' OR category = 'Uncategorized')`,
        [id],
      );
      const stamp = now();
      for (const row of rows) {
        const decided = categorizer.explain(String(row.description), Number(row.amount_cents));
        const source = decided.reason === "region" ? "region" : row.category_source === "region" ? "auto" : String(row.category_source);
        if (decided.category === row.category && source === row.category_source) continue;
        await this.db.execute(
          "UPDATE transactions SET category = $1, category_source = $2, tax_review = CASE WHEN $3 = 'Business' THEN 1 ELSE tax_review END, updated_at = $4 WHERE id = $5",
          [decided.category, source, decided.category, stamp, Number(row.id)],
        );
        if (decided.category !== row.category) changed += 1;
      }
    }
    return changed;
  }

  /** True when only the region's rules chose this parsed row's category. */
  private static decidedByRegion(categorizer: Categorizer, row: { description: string; amountCents: number; category: Category }): boolean {
    const decided = categorizer.explain(row.description, row.amountCents);
    return decided.reason === "region" && decided.category === row.category;
  }

  /**
   * The editable flags of these transactions exactly as stored, so a bulk change made by a typed
   * command can be undone precisely (see `restoreTransactionFlags`). Unknown ids are skipped.
   */
  async transactionFlags(ids: readonly number[]): Promise<TransactionFlags[]> {
    const out: TransactionFlags[] = [];
    for (let start = 0; start < ids.length; start += 200) {
      const batch = ids.slice(start, start + 200);
      const rows = await this.db.select<Row>(
        `SELECT id, category, category_source, tax_review, excluded, locally_modified, updated_at FROM transactions WHERE id IN (${batch.map((_, i) => `$${i + 1}`).join(", ")})`,
        [...batch],
      );
      for (const row of rows) {
        out.push({
          id: Number(row.id), category: String(row.category), categorySource: String(row.category_source), taxReview: Number(row.tax_review) === 1,
          excluded: Number(row.excluded) === 1, locallyModified: Number(row.locally_modified) === 1, updatedAt: String(row.updated_at),
        });
      }
    }
    return out;
  }

  /**
   * Puts transactions back exactly as `transactionFlags` read them (compensation), in one database
   * transaction. With `written` (the flags right after the change being undone), only the fields
   * that change wrote are put back, and only in rows where they still have those values: a later
   * choice wins. Returns how many rows were put back.
   */
  async restoreTransactionFlags(flags: readonly TransactionFlags[], written?: readonly TransactionFlags[]): Promise<number> {
    const after = new Map((written ?? []).map((flag) => [flag.id, flag]));
    const columns = (flag: TransactionFlags): Array<[string, unknown]> => [
      ["category", flag.category], ["category_source", flag.categorySource], ["tax_review", flag.taxReview ? 1 : 0], ["excluded", flag.excluded ? 1 : 0],
    ];
    const statements = flags.flatMap((flag): SqlStatement[] => {
      const expected = after.get(flag.id);
      if (!written) {
        return [{
          sql: "UPDATE transactions SET category = ?, category_source = ?, tax_review = ?, excluded = ?, locally_modified = ?, updated_at = ? WHERE id = ?",
          params: [...columns(flag).map(([, value]) => value), flag.locallyModified ? 1 : 0, flag.updatedAt, flag.id],
        }];
      }
      if (!expected) return [];
      const values = new Map(columns(expected));
      const changed = columns(flag).filter(([key, value]) => values.get(key) !== value);
      if (changed.length === 0) return [];
      const untouched = ["updated_at = ?", ...columns(expected).map(([key]) => `${key} = ?`)].join(" AND ");
      const same = [expected.updatedAt, ...columns(expected).map(([, value]) => value)];
      return [{
        // Untouched since: also back to "not modified here". Otherwise it stays marked as the person's. The
        // time alone does not prove it (two changes can share a millisecond), so every field must match too.
        sql: `UPDATE transactions SET ${changed.map(([key]) => `${key} = ?`).join(", ")},
          locally_modified = CASE WHEN ${untouched} THEN ? ELSE locally_modified END, updated_at = CASE WHEN ${untouched} THEN ? ELSE updated_at END
          WHERE id = ? AND deleted_at IS NULL AND ${changed.map(([key]) => `${key} = ?`).join(" AND ")}`,
        params: [...changed.map(([, value]) => value), ...same, flag.locallyModified ? 1 : 0, ...same, flag.updatedAt,
          flag.id, ...changed.map(([key]) => values.get(key))],
      }];
    });
    if (statements.length === 0) return 0;
    const results = await this.db.transaction(statements);
    return results.filter((result) => result.rowsAffected > 0).length;
  }

  /**
   * Gives these transactions one category as the person's own choice (like choosing it in the
   * list, without saving a merchant rule). The category must exist. Returns how many changed.
   */
  async setCategoryMany(ids: readonly number[], category: Category): Promise<number> {
    if (!isBuiltInCategory(category) && !(await this.customCategories()).includes(category)) throw new StoreError("invalid_category", "Unknown category.");
    const changed = await this.applyCategories(ids.map((id) => ({ id, category })));
    for (const id of ids) {
      const [row] = await this.db.select<Row>("SELECT category FROM transactions WHERE id = $1", [id]);
      await this.lockCategory([id], category, row ? String(row.category) : category);
    }
    return changed;
  }

  /** Re-saves merchant rules exactly (undo of a category deletion). */
  async restoreRules(rules: readonly MerchantRule[]): Promise<void> {
    for (const rule of rules) {
      await this.db.execute(
        "INSERT INTO merchant_rules (merchant_key, income, category, updated_at) VALUES ($1, $2, $3, $4) ON CONFLICT (merchant_key, income) DO NOTHING",
        [rule.merchantKey, rule.income ? 1 : 0, rule.category, now()],
      );
    }
  }

  async setExcluded(id: number, excluded: boolean): Promise<void> {
    const [row] = await this.db.select<Row>("SELECT uuid, user_locked_fields, excluded FROM transactions WHERE id = $1", [id]);
    const locked = new Set(parseList(row?.user_locked_fields));
    locked.add("excluded");
    await this.db.execute("UPDATE transactions SET excluded = $1, locally_modified = 1, user_locked_fields = $2, updated_at = $3 WHERE id = $4", [excluded ? 1 : 0, JSON.stringify([...locked]), now(), id]);
    if (row) await this.ledger.audit({ action: "update", subjectType: "transaction", subjectId: String(row.uuid), changes: { excluded: [Number(row.excluded) === 1, excluded] } });
  }

  /**
   * A person chose this category: lock it against automation, record it, and keep the kind in step
   * (Transfers <-> transfer-like, Income <-> income, an expense category on money in = refund).
   */
  private async lockCategory(ids: readonly number[], category: Category, previous: string): Promise<void> {
    const income = await this.ledger.incomeCategories(await this.customCategories());
    for (const id of ids) {
      const [row] = await this.db.select<Row>("SELECT t.uuid, t.amount_cents, t.kind, t.original_description, t.description, t.user_locked_fields, a.account_type FROM transactions t LEFT JOIN accounts a ON a.id = t.account_id WHERE t.id = $1", [id]);
      if (!row) continue;
      const locked = new Set(parseList(row.user_locked_fields));
      locked.add("category");
      const type = isAccountType(row.account_type) && row.account_type !== "other" ? (row.account_type as AccountType) : null;
      const kind = kindForCategorized({ amountMinor: Number(row.amount_cents), accountType: type, description: String(row.original_description ?? row.description), category, incomeCategories: income });
      await this.db.execute("UPDATE transactions SET locally_modified = 1, category_source = 'user', user_locked_fields = $1, kind = $2 WHERE id = $3", [JSON.stringify([...locked]), kind, id]);
      if (previous !== category || String(row.kind) !== kind) await this.ledger.audit({ action: "update", subjectType: "transaction", subjectId: String(row.uuid), changes: { category: [previous, category], kind: [row.kind, kind] } });
    }
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
    // One transaction: the book is emptied completely or left exactly as it was.
    await this.db.transaction([
      // The operation log is append-only (migration 0007) except while this flag is set.
      { sql: "INSERT INTO settings (key, value) VALUES ('audit_purge', '1') ON CONFLICT (key) DO UPDATE SET value = '1'" },
      ...["transaction_tags", "transaction_links", "transactions", "statements", "merchant_rules", "custom_categories", "import_staging_rows", "import_templates",
        "category_meta", "budgets", "recurring_rules", "merchants", "projects", "tags", "accounts", "organize_runs", "audit_events"].map((table) => ({ sql: `DELETE FROM ${table}` })),
      // The owner stays: an emptied database still belongs to the same account.
      options.forgetName
        ? { sql: "DELETE FROM settings WHERE key <> $1", params: ["owner_account_id"] }
        : { sql: "DELETE FROM settings WHERE key NOT IN ($1, $2, $3)", params: ["web_sync_enabled", "database_name", "owner_account_id"] },
    ]);
    // Reclaim freed pages so deleted rows do not linger in the database file.
    try {
      await this.db.execute("VACUUM");
    } catch {
      // Some drivers refuse VACUUM while other connections are open; the rows are already gone.
    }
  }

  /** Any user content makes a slot occupied, including books with only rules or dimensions. */
  async hasContent(): Promise<boolean> {
    const tables = ["statements", "accounts", "merchant_rules", "custom_categories", "category_meta", "budgets", "recurring_rules", "merchants", "projects", "tags", "import_templates", "organize_runs", "audit_events"];
    const rows = await this.db.select<Row>(`${tables.map((table) => `SELECT 1 FROM ${table}`).join(" UNION ALL ")} UNION ALL SELECT 1 FROM settings WHERE key IN ('database_name', 'currency', 'book_uuid') LIMIT 1`);
    return rows.length > 0;
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
      this.db.select<Row>(`SELECT (SELECT COUNT(*) FROM statements WHERE ${REAL_STATEMENTS}) AS statements, (SELECT COUNT(*) FROM transactions WHERE deleted_at IS NULL) AS transactions, (SELECT COUNT(*) FROM merchant_rules) AS rules`),
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
    const [range] = await this.db.select<Row>("SELECT MIN(booked_on) AS first, MAX(booked_on) AS last FROM transactions WHERE deleted_at IS NULL");
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
    // Imported statements only; manual entries, accounts and the rest travel in a backup file (backup.ts).
    const statements = await this.statements();
    const transactions = (await this.transactions()).filter((transaction) => transaction.origin !== "manual" && transaction.origin !== "recurring");
    const byStatement = new Map<number, TransferStatement["rows"]>();
    for (const t of [...transactions].reverse()) {
      const rows = byStatement.get(t.statementId) ?? [];
      rows.push({ bookedOn: t.bookedOn, description: t.description, amountCents: t.amountCents, category: t.category, taxReview: t.taxReview, excluded: t.excluded,
        kind: t.kind, originalDescription: t.originalDescription });
      byStatement.set(t.statementId, rows);
    }
    const accounts = new Map((await this.db.select<Row>("SELECT id, institution, account_last4, account_kind FROM statements WHERE account_key IS NOT NULL AND account_last4 IS NOT NULL"))
      .map((row) => [Number(row.id), { institution: (row.institution as string | null) ?? null, last4: String(row.account_last4), kind: String(row.account_kind ?? "unknown") }]));
    return {
      statements: statements.map((s) => ({
        filename: s.filename, currency: s.currency, sha256: s.sha256, closingBalanceCents: s.closingBalanceCents,
        closingBalanceOn: s.closingBalanceOn, importedAt: s.importedAt, region: s.region ?? null, rows: byStatement.get(s.id) ?? [],
        account: accounts.get(s.id) ?? null,
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
    const incomeCategories = await this.ledger.incomeCategories(await this.customCategories());
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
    // The whole merge is ONE transaction: every statement with all of its rows, the rules and the
    // settings arrive together, or the target database is left exactly as it was.
    const statements: SqlStatement[] = [];
    for (const statement of fresh) {
      // A statement keeps the account it was imported for; without one it goes to "no account".
      const identity = FinanceStore.transferAccount(statement.account);
      const accountId = identity
        ? await this.ledger.accountForImport({ ...identity, currency: statement.currency })
        : await this.ledger.unassignedAccountId(statement.currency);
      const accountType = identity ? accountTypeFromLegacy(identity.kind, "local") : null;
      statements.push({
        sql: "INSERT INTO statements (filename, currency, sha256, transaction_count, closing_balance_cents, closing_balance_on, imported_at, region, region_source, account_id, account_key, institution, account_last4, account_kind) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)",
        params: [statement.filename, statement.currency, statement.sha256, statement.rows.length, statement.closingBalanceCents, statement.closingBalanceOn, statement.importedAt || stamp,
          normalizeRegion(statement.region), regionSourceFor(normalizeRegion(statement.region), "user"), accountId, identity?.key ?? null, identity?.institution ?? null, identity?.last4 ?? null, identity?.kind ?? "unknown"],
      });
      for (let start = 0; start < statement.rows.length; start += 100) {
        const batch = statement.rows.slice(start, start + 100);
        const params: unknown[] = [statement.sha256];
        const values = batch.map((row) => {
          const base = params.length;
          const category = FinanceStore.knownCategory(row.category, custom);
          params.push(row.bookedOn, row.description, row.amountCents, category, row.taxReview ? 1 : 0, row.excluded ? 1 : 0, stamp,
            isTransactionKind(row.kind) ? row.kind : kindForCategorized({ amountMinor: row.amountCents, accountType, description: row.originalDescription ?? row.description, category, incomeCategories }),
            accountId, row.originalDescription ?? row.description, identity?.key ?? null);
          return `((SELECT id FROM statements WHERE sha256 = $1), ${Array.from({ length: 11 }, (_, i) => `$${base + i + 1}`).join(", ")})`;
        });
        statements.push({
          sql: `INSERT INTO transactions (statement_id, booked_on, description, amount_cents, category, tax_review, excluded, updated_at, kind, account_id, original_description, account_key) VALUES ${values.join(", ")}`,
          params,
        });
      }
      skipped.delete(statement.sha256);
      result.statementsAdded += 1;
      result.transactionsAdded += statement.rows.length;
    }
    if (result.statementsAdded > 0) {
      statements.push({ sql: "INSERT INTO settings (key, value) VALUES ('web_sync_skip', $1) ON CONFLICT (key) DO UPDATE SET value = excluded.value", params: [JSON.stringify([...skipped])] });
      if (currency) statements.push({ sql: "INSERT INTO settings (key, value) VALUES ('currency', $1) ON CONFLICT (key) DO NOTHING", params: [currency] });
    }
    const firstRule = statements.length;
    for (const rule of data.rules) {
      if (FinanceStore.knownCategory(rule.category, custom) !== rule.category) continue;
      statements.push({
        sql: "INSERT INTO merchant_rules (merchant_key, income, category, updated_at) VALUES ($1, $2, $3, $4) ON CONFLICT (merchant_key, income) DO NOTHING",
        params: [rule.merchantKey, rule.income ? 1 : 0, rule.category, stamp],
      });
    }
    if (statements.length === 0) return result;
    const outcomes = await this.db.transaction(statements);
    result.rulesAdded = outcomes.slice(firstRule).reduce((sum, outcome) => sum + outcome.rowsAffected, 0);
    return result;
  }

  /** A transferred statement's account as an import account (same key formula as every import), or null. */
  private static transferAccount(account: TransferStatement["account"]): { key: string; institution: string | null; last4: string; kind: AccountKind } | null {
    if (!account || !/^\d{4}$/.test(account.last4)) return null;
    const kind: AccountKind = account.kind === "checking" || account.kind === "savings" || account.kind === "credit_card" || account.kind === "loan" ? account.kind : "unknown";
    const institution = account.institution?.trim().slice(0, 80) || null;
    const key = accountKey(institution, account.last4, kind);
    return key ? { key, institution, last4: account.last4, kind } : null;
  }

  /** Every statement on this device with its transaction count and date range. */
  async statementInventory(): Promise<StatementInventoryItem[]> {
    const rows = await this.db.select<Row>(`SELECT s.id, s.filename, s.sha256, s.source, COUNT(t.id) AS transactions, MIN(t.booked_on) AS first, MAX(t.booked_on) AS last
      FROM statements s LEFT JOIN transactions t ON t.statement_id = s.id AND t.deleted_at IS NULL WHERE COALESCE(s.source_format, '') <> 'manual' GROUP BY s.id ORDER BY last DESC, s.id DESC`);
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
    await this.removeStatements([id]);
  }

  /** Removes these statements in ONE transaction: an import that arrived as a whole leaves as a whole. Returns the entries removed. */
  private async removeStatements(statementIds: readonly number[]): Promise<number> {
    const skipped = await this.skippedHashes();
    const statements: SqlStatement[] = [];
    let removed = 0;
    for (const id of new Set(statementIds)) {
      const [row] = await this.db.select<Row>("SELECT sha256, (SELECT COUNT(*) FROM transactions WHERE statement_id = $1) AS entries FROM statements WHERE id = $1", [id]);
      if (!row || String(row.sha256) === MANUAL_CONTAINER_SHA) throw new StoreError("not_found", "Statement not found.");
      skipped.add(String(row.sha256));
      removed += Number(row.entries);
      // Links and tags are removed explicitly (sql.js in tests runs without foreign-key cascades).
      statements.push(
        { sql: "DELETE FROM transaction_links WHERE from_transaction_id IN (SELECT id FROM transactions WHERE statement_id = $1) OR to_transaction_id IN (SELECT id FROM transactions WHERE statement_id = $1)", params: [id] },
        { sql: "DELETE FROM transaction_tags WHERE transaction_id IN (SELECT id FROM transactions WHERE statement_id = $1)", params: [id] },
        this.ledger.auditStatement({ actor: "user", action: "reverse_import", subjectType: "statement", subjectId: String(row.sha256), summary: `${Number(row.entries)} entries removed` }),
        { sql: "DELETE FROM transactions WHERE statement_id = $1", params: [id] },
        { sql: "DELETE FROM statements WHERE id = $1", params: [id] },
      );
    }
    if (statements.length === 0) return 0;
    // The note that keeps a website download from bringing them back goes with them.
    await this.db.transaction([
      ...statements,
      { sql: "INSERT INTO settings (key, value) VALUES ('web_sync_skip', $1) ON CONFLICT (key) DO UPDATE SET value = excluded.value", params: [JSON.stringify([...skipped])] },
      { sql: "DELETE FROM settings WHERE key = 'currency' AND NOT EXISTS (SELECT 1 FROM statements)" },
    ]);
    return removed;
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
      (SELECT COUNT(*) FROM statements WHERE source = 'local' AND COALESCE(source_format, '') <> 'manual') AS local_statements,
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

    // Transactions belonging to the website copies (kept in the "no account" account until web accounts travel too).
    const webAccountId = web.transactions.length > 0 ? await this.ledger.unassignedAccountId(web.currency ?? deviceCurrency ?? "USD") : 0;
    const existingTx = new Map((await this.db.select<Row>("SELECT * FROM transactions WHERE remote_id IS NOT NULL")).map((row) => [Number(row.remote_id), row]));
    const incoming = web.transactions.filter((transaction) => statementIdFor.has(transaction.remoteStatementId));
    const seen = new Set<number>();
    const inserts: unknown[][] = [];
    for (const transaction of incoming) {
      seen.add(transaction.remoteId);
      const statementId = statementIdFor.get(transaction.remoteStatementId)!;
      const row = existingTx.get(transaction.remoteId);
      if (!row) {
        const category = FinanceStore.knownCategory(transaction.category, custom);
        const kind = transaction.kind && isTransactionKind(transaction.kind) ? transaction.kind : legacyKind({ amountMinor: transaction.amountCents, category });
        inserts.push([statementId, transaction.bookedOn, transaction.description, transaction.amountCents, category, transaction.taxReview ? 1 : 0, transaction.excluded ? 1 : 0, stamp, transaction.remoteId,
          kind, webAccountId, "web_copy", transaction.originalDescription ?? transaction.description]);
        continue;
      }
      const keepLocal = Number(row.locally_modified) === 1;
      const locked = new Set(parseList(row.user_locked_fields));
      const next = {
        statement_id: statementId, booked_on: transaction.bookedOn,
        description: keepLocal && locked.has("description") ? String(row.description) : transaction.description, amount_cents: transaction.amountCents,
        category: keepLocal ? String(row.category) : FinanceStore.knownCategory(transaction.category, custom),
        tax_review: keepLocal ? Number(row.tax_review) : transaction.taxReview ? 1 : 0,
        excluded: keepLocal ? Number(row.excluded) : transaction.excluded ? 1 : 0,
        kind: keepLocal || !transaction.kind || !isTransactionKind(transaction.kind) ? String(row.kind) : transaction.kind,
      };
      const changed = (Object.keys(next) as Array<keyof typeof next>).some((key) => String(row[key]) !== String(next[key]));
      if (!changed) continue;
      await this.db.execute(
        "UPDATE transactions SET statement_id = $1, booked_on = $2, description = $3, amount_cents = $4, category = $5, tax_review = $6, excluded = $7, kind = $8, updated_at = $9 WHERE id = $10",
        [next.statement_id, next.booked_on, next.description, next.amount_cents, next.category, next.tax_review, next.excluded, next.kind, stamp, Number(row.id)],
      );
      result.transactionsUpdated += 1;
    }
    for (let start = 0; start < inserts.length; start += 100) {
      const batch = inserts.slice(start, start + 100);
      const params = batch.flat();
      const values = batch.map((_, i) => `(${Array.from({ length: 13 }, (_, j) => `$${i * 13 + j + 1}`).join(", ")})`);
      await this.db.execute(
        `INSERT INTO transactions (statement_id, booked_on, description, amount_cents, category, tax_review, excluded, updated_at, remote_id, kind, account_id, entry_origin, original_description) VALUES ${values.join(", ")}`,
        params,
      );
      result.transactionsAdded += batch.length;
    }
    for (const [remoteId, row] of existingTx) {
      if (seen.has(remoteId)) continue;
      await this.db.execute("DELETE FROM transaction_links WHERE from_transaction_id = $1 OR to_transaction_id = $1", [Number(row.id)]);
      await this.db.execute("DELETE FROM transaction_tags WHERE transaction_id = $1", [Number(row.id)]);
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

  /**
   * Transactions whose category was set automatically. Rules and newer keyword lists only clean up
   * these: a category the person chose, even "Uncategorized", is never changed by them.
   */
  private async automaticTransactions(): Promise<Transaction[]> {
    const chosen = new Set((await this.db.select<Row>(`SELECT id FROM transactions WHERE category_source = 'user' OR COALESCE(user_locked_fields, '') LIKE '%"category"%' OR entry_origin IN ('manual', 'recurring')`)).map((row) => Number(row.id)));
    return (await this.transactions()).filter((transaction) => !chosen.has(transaction.id));
  }

  private async applyCategories(changes: Array<{ id: number; category: Category }>): Promise<number> {
    const stamp = now();
    if (changes.length > 0) {
      await this.db.transaction(changes.map((change) => ({
        // Business purchases are flagged for tax review, as in Rails.
        sql: "UPDATE transactions SET category = $1, tax_review = CASE WHEN $2 = 'Business' THEN 1 ELSE tax_review END, updated_at = $3 WHERE id = $4",
        params: [change.category, change.category, stamp, change.id],
      })));
    }
    return changes.length;
  }
}
