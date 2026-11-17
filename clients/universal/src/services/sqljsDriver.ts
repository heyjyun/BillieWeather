// SqlDriver over sql.js (SQLite compiled to WebAssembly). Used by tests and by the
// browser preview (`npm run dev` outside Tauri), where nothing is persisted.
import type { Database } from "sql.js";
import type { SqlDriver, SqlStatement } from "./store";

export function sqljsDriver(db: Database): SqlDriver {
  const run = (sql: string, params: unknown[] = []) => {
    db.run(sql, params as never);
    const lastInsertId = Number(db.exec("SELECT last_insert_rowid()")[0]?.values[0][0] ?? 0);
    return { rowsAffected: db.getRowsModified(), lastInsertId };
  };
  const read = <T>(sql: string, params: unknown[] = []) => {
    const statement = db.prepare(sql);
    try {
      statement.bind(params as never);
      const rows: T[] = [];
      while (statement.step()) rows.push(statement.getAsObject() as T);
      return rows;
    } finally {
      statement.free();
    }
  };
  return {
    execute: async (sql, params) => run(sql, params),
    select: async <T>(sql: string, params?: unknown[]) => read<T>(sql, params),
    // One connection and no awaits between statements: the batch is one SQLite transaction.
    async transaction(statements) {
      db.run("BEGIN IMMEDIATE");
      try {
        const results = statements.map((statement) => run(statement.sql, statement.params));
        db.run("COMMIT");
        return results;
      } catch (error) {
        try {
          db.run("ROLLBACK");
        } catch {
          // SQLite already rolled the transaction back.
        }
        throw error;
      }
    },
    snapshot: async <T>(queries: readonly SqlStatement[]) => queries.map((query) => read<T>(query.sql, query.params)),
  };
}
