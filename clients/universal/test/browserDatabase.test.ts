// The browser preview's database and the schema checks shared with native books (2026-11-28: a dev
// server serving migrations 1–10 to code that needs 11 made sign-in fail with "no such table:
// categories"). Synthetic data only.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import initSqlJs, { type Database } from "sql.js";
import { MIGRATIONS_DIR, migrate } from "./helpers";
import { LOCAL_SCHEMA_VERSION } from "../src/services/backup";
import { MIGRATION_FAILED, PREVIEW_STALE, checkServedMigrations, openBrowserDatabase, orderedMigrations } from "../src/services/browserDatabase";
import { MIGRATION_SOURCES, migrationVersions } from "../src/services/migrations";
import { openFailure } from "../src/services/databases";
import { checkRequiredTables, checkSchemaVersion } from "../src/services/platform";
import { REQUIRED_TABLES, missingTables } from "../src/services/schemaChecks";
import { sqljsDriver } from "../src/services/sqljsDriver";
import { FinanceStore } from "../src/services/store";
import { MESSAGES } from "../src/i18n";

/** The migrations as import.meta.glob hands them to platform.ts (keys are paths relative to it). */
function globbed(filter: (name: string) => boolean = () => true): Record<string, string> {
  return Object.fromEntries(readdirSync(MIGRATIONS_DIR).filter((name) => name.endsWith(".sql") && filter(name))
    .map((name) => [`../../src-tauri/migrations/${name}`, readFileSync(join(MIGRATIONS_DIR, name), "utf8")]));
}
const latest = String(LOCAL_SCHEMA_VERSION).padStart(4, "0");
const all = globbed();
const select = (db: Database) => async (sql: string) => {
  const [result] = db.exec(sql);
  return result ? result.values.map((values) => Object.fromEntries(result.columns.map((column, i) => [column, values[i]]))) : [];
};
const schema = (db: Database) => db.exec("SELECT type, name, sql FROM sqlite_master WHERE name NOT IN ('test_migrations', 'sqlite_sequence') ORDER BY type, name")[0].values;
const failureOf = (error: unknown) => openFailure(error instanceof Error ? error.message : String(error));

describe("browser preview database", () => {
  it("is built from an empty database with every migration and every required table", async () => {
    const SQL = await initSqlJs();
    const db = await openBrowserDatabase(SQL, globbed());
    expect(await missingTables(select(db))).toEqual([]);
    expect(REQUIRED_TABLES).toContain("categories");
  });

  it("bundles exactly the migration files on disk, and derives the schema version from them", () => {
    expect(Object.fromEntries(Object.entries(MIGRATION_SOURCES).map(([path, sql]) => [path.split("/").pop(), sql])))
      .toEqual(Object.fromEntries(Object.entries(all).map(([path, sql]) => [path.split("/").pop(), sql])));
    expect(LOCAL_SCHEMA_VERSION).toBe(readdirSync(MIGRATIONS_DIR).filter((name) => /^\d{4}_.+\.sql$/.test(name)).length);
  });

  it("has exactly the schema of a native book migrated the same way", async () => {
    const SQL = await initSqlJs();
    const native = new SQL.Database();
    migrate(native);
    expect(schema(await openBrowserDatabase(SQL, globbed()))).toEqual(schema(native));
  });

  it("serves the category tree right after it opens (what sign-in reads first)", async () => {
    const store = new FinanceStore(sqljsDriver(await openBrowserDatabase(await initSqlJs(), globbed())));
    const rows = await store.categoryRows();
    expect(rows.filter((row) => row.parent === null)).toHaveLength(14);
    expect(rows.filter((row) => row.parent !== null)).toHaveLength(70);
  });

  it("reproduces the 2026-11-28 failure: without the newest migration the old code opened a database without categories", async () => {
    const SQL = await initSqlJs();
    const stale = globbed((name) => Number(name.slice(0, 4)) <= 10);
    // What the old platform.ts did: run whatever the dev server provided and hand it to the app, which
    // failed at sign-in with "no such table: categories" (test/previewSignIn.test.tsx shows that path).
    const old = new SQL.Database();
    for (const path of Object.keys(stale).sort()) old.exec(stale[path]);
    expect(await missingTables(select(old))).toContain("categories");
    // Now, first: the page's list is compared with the dev server's reading of the folder.
    const error = (() => { try { checkServedMigrations(stale, migrationVersions(all)); } catch (caught) { return caught; } })();
    expect(String((error as Error).message)).toContain(PREVIEW_STALE);
    expect(String((error as Error).message)).toMatch(/has migration versions 1, .*10, but the migrations folder has 1, .*11/);
    expect(String((error as Error).message)).toMatch(/restart the development server/i);
    expect(failureOf(error)).toBe("previewStale");
    // And even without that check, the required tables (a list in the code, not derived from the
    // migrations) refuse the database before anything reads it.
    const missing = await openBrowserDatabase(SQL, stale).catch((caught: unknown) => caught);
    expect(String((missing as Error).message)).toMatch(/required tables are missing: categories/);
    expect(failureOf(missing)).toBe("migrationFailed");
  });

  it("compares the served migrations with the dev server's folder, and refuses a server that cannot tell", () => {
    expect(() => checkServedMigrations(all, migrationVersions(all))).not.toThrow();
    const withNext = [...migrationVersions(all), LOCAL_SCHEMA_VERSION + 1];
    expect(() => checkServedMigrations(all, withNext)).toThrow(PREVIEW_STALE);
    const old = (() => { try { checkServedMigrations(all, null); } catch (caught) { return caught as Error; } })();
    expect(old?.message).toMatch(/does not report its migration files/);
    expect(failureOf(old)).toBe("previewStale");
  });

  it("refuses a gap or a duplicate version, naming the versions", () => {
    const without3 = Object.fromEntries(Object.entries(all).filter(([path]) => !path.includes("/0003_")));
    expect(() => orderedMigrations(without3)).toThrow(/without gaps or duplicates, but the versions are 1, 2, 4/);
    expect(failureOf((() => { try { orderedMigrations(without3); } catch (caught) { return caught; } })())).toBe("migrationFailed");
    expect(() => orderedMigrations({ ...all, "../../src-tauri/migrations/0003_duplicate.sql": "SELECT 1;" })).toThrow(/1, 2, 3, 3, 4/);
    expect(() => orderedMigrations({})).toThrow(/versions are none/);
    // Files that are not migrations are ignored, and the order is by version, not by key.
    expect(orderedMigrations({ ...all, "../../src-tauri/migrations/README.md": "#" }).map((m) => m.version)).toEqual(Array.from({ length: LOCAL_SCHEMA_VERSION }, (_, i) => i + 1));
  });

  it("takes a new migration file (the next number) with no other change", async () => {
    const next = String(LOCAL_SCHEMA_VERSION + 1).padStart(4, "0");
    const future = { ...all, [`../../src-tauri/migrations/${next}_future_feature.sql`]: "CREATE TABLE zxq_future (id INTEGER PRIMARY KEY);" };
    expect(migrationVersions(future)).toEqual(Array.from({ length: LOCAL_SCHEMA_VERSION + 1 }, (_, i) => i + 1));
    expect(() => checkServedMigrations(future, migrationVersions(future))).not.toThrow();
    const db = await openBrowserDatabase(await initSqlJs(), future);
    expect(db.exec("SELECT name FROM sqlite_master WHERE name = 'zxq_future'")[0].values).toEqual([["zxq_future"]]);
  });

  it("names a failing migration instead of continuing, and opens again once the file is fixed", async () => {
    const SQL = await initSqlJs();
    const broken = Object.fromEntries(Object.entries(all).map(([path, sql]) => [path, path.includes(`/${latest}_`) ? `${sql}\nSELECT * FROM table_that_does_not_exist;` : sql]));
    const error = await openBrowserDatabase(SQL, broken).catch((caught: unknown) => caught);
    expect(String((error as Error).message)).toMatch(new RegExp(`migration ${latest}_.+\\.sql ${MIGRATION_FAILED}: .*no such table: table_that_does_not_exist`));
    expect(failureOf(error)).toBe("migrationFailed");
    const recovered = await openBrowserDatabase(SQL, all);
    expect(await missingTables(select(recovered))).toEqual([]);
  });

  it("reports missing required tables as a failed migration, by name", async () => {
    const SQL = await initSqlJs();
    const dropping = Object.fromEntries(Object.entries(all).map(([path, sql]) => [path, path.includes(`/${latest}_`) ? `${sql}\nDROP TABLE budgets;` : sql]));
    const error = await openBrowserDatabase(SQL, dropping).catch((caught: unknown) => caught);
    expect(String((error as Error).message)).toMatch(/required tables are missing: budgets/);
    expect(failureOf(error)).toBe("migrationFailed");
  });
});

describe("native books: schema version and required tables", () => {
  it("upgrades an older book step by step, keeps its rows, and then passes both checks", async () => {
    const SQL = await initSqlJs();
    const db = new SQL.Database();
    migrate(db, 10);
    db.run("INSERT INTO statements (filename, currency, sha256, transaction_count, imported_at) VALUES ('zxq.csv','USD','zxq',1,'2026-01-01')");
    db.run("INSERT INTO transactions (statement_id, booked_on, description, amount_cents, category, updated_at, kind) VALUES (1,'2026-01-02','ZXQ SYNTHETIC',-500,'Shopping','x','expense')");
    expect(await missingTables(select(db))).toContain("categories");
    migrate(db);
    expect(db.exec("SELECT description, amount_cents FROM transactions")[0].values).toEqual([["ZXQ SYNTHETIC", -500]]);
    await expect(checkRequiredTables(select(db))).resolves.toBeUndefined();
    const versions = async () => [{ version: LOCAL_SCHEMA_VERSION, first_version: 1, total: LOCAL_SCHEMA_VERSION, applied: LOCAL_SCHEMA_VERSION }];
    await expect(checkSchemaVersion(versions)).resolves.toBeUndefined();
  });

  it("refuses a book that claims the current version but lacks a table, as 'incomplete', without changing it", async () => {
    const SQL = await initSqlJs();
    const db = new SQL.Database();
    migrate(db);
    db.run("DROP TABLE categories");
    const before = db.export();
    const error = await checkRequiredTables(select(db)).catch((caught: unknown) => caught);
    expect(String((error as Error).message)).toMatch(/missing tables: categories/);
    expect(failureOf(error)).toBe("incomplete");
    expect(db.export()).toEqual(before);
  });

  it("tells a migration the native SQL plugin could not run apart from outdated, newer and damaged books", () => {
    expect(openFailure("error returned from database: while executing migration 11: (code: 1) no such column: x")).toBe("migrationFailed");
    expect(openFailure("while executing migration 11: error returned from database")).toBe("migrationFailed");
    expect(openFailure("migration 12 was previously applied but is missing in the resolved migrations")).toBe("newer");
    expect(openFailure("the local database schema is incomplete (version 10, 10 of 11 migrations)")).toBe("incomplete");
    expect(openFailure("file is not a database")).toBe("damaged");
  });

  it("every app language explains both new failures in its own words", () => {
    for (const [locale, copy] of Object.entries(MESSAGES)) {
      const failure = copy.boot.failure;
      for (const key of ["previewStale", "migrationFailed"] as const) {
        expect(failure[key], `${locale} ${key}`).toBeTruthy();
        expect(failure[key], `${locale} ${key}`).not.toBe(failure.other);
        if (locale !== "en") expect(failure[key], `${locale} ${key}`).not.toBe(MESSAGES.en.boot.failure[key]);
      }
    }
  });
});
