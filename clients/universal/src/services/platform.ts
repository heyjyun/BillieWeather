// The only platform-specific code in the UI: where the database lives and how a file is
// saved. Inside Tauri (macOS, Windows, iOS, Android) data goes to SQLite in the app's
// private directory. In a plain browser (`npm run dev`) an in-memory database is used
// and nothing is persisted.
import type { SqlDriver } from "./store";

export const isTauri = () => typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export async function openDatabase(file = "billieweather.db"): Promise<{ driver: SqlDriver; persistent: boolean }> {
  if (isTauri()) {
    const { default: Database } = await import("@tauri-apps/plugin-sql");
    const db = await Database.load(`sqlite:${file}`);
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

/** A generic label from the WebView when the OS gives no name ("iPhone", "Android", …). */
export function genericDeviceName(userAgent = typeof navigator === "undefined" ? "" : navigator.userAgent): string | null {
  if (/iPad/.test(userAgent) || (/Macintosh/.test(userAgent) && typeof navigator !== "undefined" && navigator.maxTouchPoints > 1)) return "iPad";
  if (/iPhone|iPod/.test(userAgent)) return "iPhone";
  if (/Android/.test(userAgent)) return "Android";
  if (/Macintosh|Mac OS X/.test(userAgent)) return "Mac";
  if (/Windows/.test(userAgent)) return "Windows PC";
  return null;
}

/**
 * The device's own name (computer name on macOS/Windows, model on Android), used as the
 * default name for this device's database. Null when nothing is known.
 */
export async function deviceName(): Promise<string | null> {
  if (isTauri()) {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const name = await invoke<string | null>("device_name");
      if (name && name.trim()) return name.trim();
    } catch {
      // Fall back to the generic label below.
    }
  }
  return genericDeviceName();
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
