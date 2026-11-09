// The only platform-specific code in the UI: where the database lives and how a file is
// saved. Inside Tauri (macOS, Windows, iOS, Android) data goes to SQLite in the app's
// private directory. In a plain browser (`npm run dev`) an in-memory database is used
// and nothing is persisted.
import type { SqlDriver } from "./store";

export const isTauri = () => typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export async function openDatabase(): Promise<{ driver: SqlDriver; persistent: boolean }> {
  if (isTauri()) {
    const { default: Database } = await import("@tauri-apps/plugin-sql");
    const db = await Database.load("sqlite:billieweather.db");
    return {
      persistent: true,
      driver: {
        execute: async (sql, params) => {
          const result = await db.execute(sql, params);
          return { rowsAffected: result.rowsAffected, lastInsertId: result.lastInsertId };
        },
        select: (sql, params) => db.select(sql, params),
      },
    };
  }
  const [{ default: initSqlJs }, { default: wasmUrl }, { sqljsDriver }] = await Promise.all([
    import("sql.js"),
    import("sql.js/dist/sql-wasm.wasm?url"),
    import("./sqljsDriver"),
  ]);
  const SQL = await initSqlJs({ locateFile: () => wasmUrl });
  const db = new SQL.Database();
  const migrations = import.meta.glob("../../src-tauri/migrations/*.sql", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
  for (const path of Object.keys(migrations).sort()) db.exec(migrations[path]);
  return { driver: sqljsDriver(db), persistent: false };
}

/** Saves bytes to a file the person chooses. Returns false if they cancelled. */
export async function saveFile(filename: string, bytes: Uint8Array, mime: string): Promise<boolean> {
  if (isTauri()) {
    const [{ save }, { writeFile }] = await Promise.all([import("@tauri-apps/plugin-dialog"), import("@tauri-apps/plugin-fs")]);
    const extension = filename.split(".").pop() ?? "";
    const path = await save({ defaultPath: filename, filters: [{ name: extension.toUpperCase(), extensions: [extension] }] });
    if (!path) return false;
    await writeFile(path, bytes);
    return true;
  }
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: mime }));
  const link = Object.assign(document.createElement("a"), { href: url, download: filename });
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return true;
}
