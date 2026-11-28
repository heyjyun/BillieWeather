// Checks that a local SQLite database has the structure this build was written for, before any page,
// sign-in or sync code reads it. Shared by the native books (after the SQL plugin migrated them) and
// the in-memory browser preview (after src/services/browserDatabase.ts migrated it).

/**
 * Tables the app reads or writes on every launch, or right after sign-in. A database without one of
 * them fails here, with the names, instead of later with "no such table" in the middle of a page.
 * The latest migration's table (`categories`, 0011) is part of the list on purpose. A test
 * (test/browserDatabase.test.ts) checks that the migrations create every table listed here.
 */
export const REQUIRED_TABLES = [
  "settings", "statements", "transactions", "accounts", "categories", "category_meta", "custom_categories",
  "transaction_tags", "transaction_links", "merchant_rules", "recurring_rules", "budgets", "history_state",
] as const;

/** The required tables this database lacks (empty when all are present). */
export async function missingTables(select: (sql: string) => Promise<unknown[]>): Promise<string[]> {
  const rows = (await select("SELECT name FROM sqlite_master WHERE type = 'table'")) as Array<{ name?: unknown }>;
  const present = new Set(rows.map((row) => String(row.name)));
  return REQUIRED_TABLES.filter((table) => !present.has(table));
}
