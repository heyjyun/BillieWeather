// SqlDriver over sql.js (SQLite compiled to WebAssembly). Used by tests and by the
// browser preview (`npm run dev` outside Tauri), where nothing is persisted.
import type { Database } from "sql.js";
import type { SqlDriver } from "./store";

export function sqljsDriver(db: Database): SqlDriver {
  return {
    async execute(sql, params = []) {
      db.run(sql, params as never);
      const lastInsertId = Number(db.exec("SELECT last_insert_rowid()")[0]?.values[0][0] ?? 0);
      return { rowsAffected: db.getRowsModified(), lastInsertId };
    },
    async select<T>(sql: string, params: unknown[] = []) {
      const statement = db.prepare(sql);
      try {
        statement.bind(params as never);
        const rows: T[] = [];
        while (statement.step()) rows.push(statement.getAsObject() as T);
        return rows;
      } finally {
        statement.free();
      }
    },
  };
}
