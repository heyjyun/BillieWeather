import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import initSqlJs, { type Database } from "sql.js";
import { sqljsDriver } from "../src/services/sqljsDriver";
import { FinanceStore } from "../src/services/store";

export const MIGRATIONS_DIR = join(__dirname, "../src-tauri/migrations");
export const FIXTURES = join(__dirname, "../../../packages/finance-core/fixtures");

export function migrate(db: Database) {
  for (const file of readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort()) db.exec(readFileSync(join(MIGRATIONS_DIR, file), "utf8"));
}

export async function newStore() {
  const SQL = await initSqlJs();
  const db = new SQL.Database();
  migrate(db);
  return { db, store: new FinanceStore(sqljsDriver(db)) };
}

export const fixtureBytes = (name: string) => new Uint8Array(readFileSync(join(FIXTURES, "statements", name)));
