// The browser preview's database (`npm run dev` outside Tauri): SQLite in memory, built from the same
// migration files the native app uses (src-tauri/migrations, bundled by migrations.ts). Nothing is
// persisted, so there is no user data to protect here, but the schema must still be complete before
// sign-in reads it.
//
// The dev server resolves the migration list once and refreshes it only when it sees a file change.
// If it cannot see the folder (as before 2026-11-28, when vite.config.ts ignored all of src-tauri), the
// list goes stale and sign-in failed with "no such table: categories". The schema version is derived
// from that same list, so it cannot tell on its own. The independent check is the dev server's own
// reading of the folder (GET /__billie/dev-status, devServerSync.ts), compared in platform.ts.
import type { Database, SqlJsStatic } from "sql.js";
import { migrationVersions } from "./migrations";
import { missingTables } from "./schemaChecks";

export interface BrowserMigration { version: number; name: string; sql: string }

/** Matched by openFailure() in databases.ts: the page's migration list is not the folder's. */
export const PREVIEW_STALE = "browser preview migrations are out of date";
/** Matched by openFailure(): a migration's SQL failed, or the files are not numbered 1..n. */
export const MIGRATION_FAILED = "failed while preparing the database";

const RESTART = "Restart the development server (ops/dev-services.sh preview restart, or npm run dev) and reload the page.";
const list = (versions: readonly number[]) => (versions.length ? versions.join(", ") : "none");

/** The migrations in version order, refused unless they are numbered exactly 1..n (no gap, no duplicate). */
export function orderedMigrations(modules: Record<string, string>): BrowserMigration[] {
  const migrations = Object.entries(modules)
    .map(([path, sql]) => ({ name: path.split("/").pop() ?? path, sql }))
    .filter(({ name }) => /^\d{4}_.+\.sql$/.test(name))
    .map(({ name, sql }) => ({ version: Number(name.slice(0, 4)), name, sql }))
    .sort((a, b) => a.version - b.version || a.name.localeCompare(b.name));
  const versions = migrations.map((migration) => migration.version);
  if (!versions.length || !versions.every((version, index) => version === index + 1)) {
    throw new Error(`the migration files ${MIGRATION_FAILED}: they must be numbered 1, 2, 3 … without gaps or duplicates, but the versions are ${list(versions)}.`);
  }
  return migrations;
}

/**
 * Compares the migrations this page was given with the ones the dev server reads from the folder
 * right now (null: the server does not report them, so it predates this check and may be stale).
 */
export function checkServedMigrations(modules: Record<string, string>, onDisk: readonly number[] | null): void {
  const served = migrationVersions(modules);
  if (onDisk === null) throw new Error(`${PREVIEW_STALE}: the development server does not report its migration files, so it was started before it could follow them. ${RESTART}`);
  if (served.length !== onDisk.length || served.some((version, index) => version !== onDisk[index])) {
    throw new Error(`${PREVIEW_STALE}: this page has migration versions ${list(served)}, but the migrations folder has ${list(onDisk)}. ${RESTART}`);
  }
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

export async function openBrowserDatabase(SQL: SqlJsStatic, modules: Record<string, string>): Promise<Database> {
  const migrations = orderedMigrations(modules);
  const db = new SQL.Database();
  try {
    migrateBrowserDatabase(db, migrations);
    const missing = await missingTables(async (sql) => db.exec(sql)[0]?.values.map(([name]) => ({ name })) ?? []);
    if (missing.length) throw new Error(`migrations 1–${migrations.length} ${MIGRATION_FAILED}: they ran, but these required tables are missing: ${missing.join(", ")}`);
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

/**
 * What platform.ts runs in the browser: compare the served migrations with the dev server's folder
 * (`onDisk`; undefined outside a dev server, where the bundle cannot go stale), then build the database.
 */
export async function openPreviewDatabase(SQL: SqlJsStatic, modules: Record<string, string>, onDisk?: readonly number[] | null): Promise<Database> {
  if (onDisk !== undefined) checkServedMigrations(modules, onDisk);
  return openBrowserDatabase(SQL, modules);
}
