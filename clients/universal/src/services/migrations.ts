// The local SQLite schema's migrations: every src-tauri/migrations/NNNN_*.sql file. The native app
// registers the same folder (src-tauri/build.rs generates its migration list), so adding
// 0012_something.sql needs no other change: the schema version below, the native version gate, the
// browser preview and backups all follow the folder.
//
// The texts are bundled because the browser preview (`npm run dev` outside Tauri) builds its
// in-memory database from them; the native app migrates through its SQL plugin instead.

/** Path → SQL text, as the bundler found them. */
export const MIGRATION_SOURCES = import.meta.glob("../../src-tauri/migrations/*.sql", { query: "?raw", import: "default", eager: true }) as Record<string, string>;

/** Version numbers of the migration files (NNNN_name.sql), ascending; duplicates kept so they can be refused. */
export function migrationVersions(sources: Record<string, string>): number[] {
  return Object.keys(sources)
    .map((path) => path.split("/").pop() ?? path)
    .filter((name) => /^\d{4}_.+\.sql$/.test(name))
    .map((name) => Number(name.slice(0, 4)))
    .sort((a, b) => a - b);
}

/**
 * The schema version this build was written for: the number of migration files, which are numbered
 * 1..n without gaps (refused otherwise by browserDatabase.ts, by build.rs and by test/schemaGate.test.ts).
 */
export const LOCAL_SCHEMA_VERSION = migrationVersions(MIGRATION_SOURCES).length;
