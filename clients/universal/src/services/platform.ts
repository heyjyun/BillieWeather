// The only platform-specific code in the UI: where the database lives and how a file is
// saved. Inside Tauri (macOS, Windows, iOS, Android) data goes to SQLite in the app's
// private directory. In a plain browser (`npm run dev`) an in-memory database is used
// and nothing is persisted.
import type { SqlDriver, SqlStatement } from "./store";

export const isTauri = () => typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export async function openDatabase(file = "billieweather.db"): Promise<{ driver: SqlDriver; persistent: boolean }> {
  if (isTauri()) {
    const { default: Database } = await import("@tauri-apps/plugin-sql");
    const url = `sqlite:${file}`;
    const db = await Database.load(url);
    const { invoke } = await import("@tauri-apps/api/core");
    const batch = (statements: readonly SqlStatement[]) => statements.map((statement) => ({ sql: statement.sql, params: statement.params ?? [] }));
    return {
      persistent: true,
      driver: {
        execute: async (sql, params) => {
          const result = await db.execute(sql, params);
          return { rowsAffected: result.rowsAffected, lastInsertId: result.lastInsertId };
        },
        select: (sql, params) => db.select(sql, params),
        // The plugin pools connections, so a transaction cannot span calls: the whole batch goes to
        // the native side, which runs it on one connection in one transaction (src-tauri/src/transaction.rs).
        transaction: (statements) => invoke("db_transaction", { db: url, statements: batch(statements) }),
        snapshot: (queries) => invoke("db_snapshot", { db: url, queries: batch(queries) }),
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

/**
 * This installation's identity for the website's "Local databases" cards, or null when it
 * must not report: a plain browser (its database is in memory and disappears on reload), a QA
 * or debug build, or an identity file that cannot be read. The id itself is kept by the native
 * side in a file next to the SQLite databases (src-tauri/src/identity.rs), so it is the same
 * for every WebView origin and survives restarts and updates. `candidate` is only used the
 * very first time (a fresh random id, or the one an older version kept in WebView storage).
 */
export interface DeviceIdentity { deviceId: string; platform: string; reportable: boolean }
export async function deviceIdentity(candidate: string): Promise<DeviceIdentity | null> {
  if (!isTauri()) return null;
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    return await invoke<DeviceIdentity>("device_identity", { candidate });
  } catch {
    return null;
  }
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

/** Reads a file the person chooses (backup restore). Null when they cancelled. */
export async function openFile(extensions: string[]): Promise<{ name: string; bytes: Uint8Array } | null> {
  if (isTauri()) {
    const [{ open }, { readFile }] = await Promise.all([import("@tauri-apps/plugin-dialog"), import("@tauri-apps/plugin-fs")]);
    const path = await open({ multiple: false, directory: false, filters: [{ name: extensions.join("/").toUpperCase(), extensions }] });
    if (!path || Array.isArray(path)) return null;
    return { name: String(path).split(/[\\/]/).pop() ?? "backup", bytes: await readFile(String(path)) };
  }
  return new Promise((resolve) => {
    const input = Object.assign(document.createElement("input"), { type: "file", accept: extensions.map((e) => `.${e}`).join(",") });
    input.onchange = async () => {
      const file = input.files?.[0];
      resolve(file ? { name: file.name, bytes: new Uint8Array(await file.arrayBuffer()) } : null);
    };
    input.click();
  });
}

/** The automatic pre-migration copies (native app only; names, never paths). */
export async function listSnapshots(): Promise<Array<{ name: string; database: string; version: number; created: number; size: number }>> {
  if (!isTauri()) return [];
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke("snapshot_list");
}

/** Copies an automatic copy into an empty slot (native app only). Throws when the slot is in use. */
export async function restoreSnapshot(snapshot: string, slot: number): Promise<void> {
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("snapshot_restore", { snapshot, slot });
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
