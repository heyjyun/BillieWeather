import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import initSqlJs, { type Database } from "sql.js";
import { sqljsDriver } from "../src/services/sqljsDriver";
import { FinanceStore } from "../src/services/store";

export const MIGRATIONS_DIR = join(__dirname, "../src-tauri/migrations");
export const FIXTURES = join(__dirname, "../../../packages/finance-core/fixtures");

/** Applies each migration once, in order (like Tauri's SQL plugin). `upTo` stops at that version. */
export function migrate(db: Database, upTo = Infinity) {
  db.exec("CREATE TABLE IF NOT EXISTS test_migrations (version INTEGER PRIMARY KEY)");
  const applied = new Set((db.exec("SELECT version FROM test_migrations")[0]?.values ?? []).map((row) => Number(row[0])));
  for (const file of readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort()) {
    const version = Number(file.slice(0, 4));
    if (version > upTo || applied.has(version)) continue;
    db.exec(readFileSync(join(MIGRATIONS_DIR, file), "utf8"));
    db.run("INSERT INTO test_migrations (version) VALUES (?)", [version]);
  }
}

export async function newStore() {
  const SQL = await initSqlJs();
  const db = new SQL.Database();
  migrate(db);
  return { db, store: new FinanceStore(sqljsDriver(db)) };
}

export const fixtureBytes = (name: string) => new Uint8Array(readFileSync(join(FIXTURES, "statements", name)));
