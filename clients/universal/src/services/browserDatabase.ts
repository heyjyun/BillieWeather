// The browser preview's database (`npm run dev` outside Tauri): SQLite in memory, built from the same
// migration files the native app uses (src-tauri/migrations). Nothing is persisted, so there is no
// user data to protect here, but the schema must still be complete before sign-in reads it.
//
// The migration texts come from an `import.meta.glob` in platform.ts, which the dev server resolves
// once and then only refreshes when it sees a migration file change. If it cannot see the folder (as
// before 2026-11-28, when vite.config.ts ignored all of src-tauri) the list goes stale and the app
// later failed with "no such table: categories". The checks below make that state explicit.
import type { Database, SqlJsStatic } from "sql.js";
import { LOCAL_SCHEMA_VERSION } from "./backup";
import { missingTables } from "./schemaChecks";

export interface BrowserMigration { version: number; name: string; sql: string }

/** Matched by openFailure() in databases.ts: the dev server's migration list differs from this build's. */
export const PREVIEW_STALE = "browser preview migrations are out of date";
/** Matched by openFailure(): one migration's SQL failed. */
export const MIGRATION_FAILED = "failed while preparing the database";

/**
 * The migrations in version order, refused unless they are exactly versions 1..expected: a missing,
 * duplicated or extra file means the dev server serves a different set than the code was written for.
 */
export function orderedMigrations(modules: Record<string, string>, expected = LOCAL_SCHEMA_VERSION): BrowserMigration[] {
  const migrations = Object.entries(modules)
    .map(([path, sql]) => ({ name: path.split("/").pop() ?? path, sql }))
    .filter(({ name }) => /^\d{4}_.+\.sql$/.test(name))
    .map(({ name, sql }) => ({ version: Number(name.slice(0, 4)), name, sql }))
    .sort((a, b) => a.version - b.version || a.name.localeCompare(b.name));
  const versions = migrations.map((migration) => migration.version);
  const contiguous = versions.length === expected && versions.every((version, index) => version === index + 1);
  if (!contiguous) {
    const found = versions.length ? versions.join(", ") : "none";
    throw new Error(`${PREVIEW_STALE}: the development server provided migration versions ${found}, but this build needs 1–${expected}. Restart the development server (ops/dev-services.sh preview restart, or npm run dev) and reload the page.`);
  }
  return migrations;
}

/**
 * Applies every migration in order. A failing migration is named in the error and nothing is retried
 * silently; openBrowserDatabase discards the half-built in-memory database.
 */
export function migrateBrowserDatabase(db: Database, migrations: readonly BrowserMigration[]): void {
  for (const migration of migrations) {
    try {
      db.exec(migration.sql);
    } catch (error) {
      throw new Error(`migration ${migration.name} ${MIGRATION_FAILED}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

export async function openBrowserDatabase(SQL: SqlJsStatic, modules: Record<string, string>, expected = LOCAL_SCHEMA_VERSION): Promise<Database> {
  const migrations = orderedMigrations(modules, expected);
  const db = new SQL.Database();
  try {
    migrateBrowserDatabase(db, migrations);
    const missing = await missingTables(async (sql) => db.exec(sql)[0]?.values.map(([name]) => ({ name })) ?? []);
    if (missing.length) throw new Error(`migrations 1–${expected} ${MIGRATION_FAILED}: they ran, but these required tables are missing: ${missing.join(", ")}`);
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}
