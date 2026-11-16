// Local backup and restore (review P0-5, invariant I-17).
//
// A backup is a complete logical copy of one database (one book): every row of every table, with
// a manifest of row counts and amount totals and a SHA-256 checksum. It is written only to a file
// the person chooses (never uploaded) and can be encrypted with a passphrase (PBKDF2 + AES-GCM,
// Web Crypto) before it leaves memory.
//
// A restore ALWAYS goes into a new, empty database slot, never over an existing one. After the
// rows are written, counts and totals are compared with the manifest; on any difference the new
// slot is emptied again and the restore fails. The original database is never touched.
//
// Automatic protection before schema migrations is separate: src-tauri/src/snapshot.rs copies the
// database files byte for byte before a new migration runs.
import type { SqlDriver } from "./store";
import { randomId } from "./ids";

export const BACKUP_FORMAT = "billieweather-backup";
export const BACKUP_VERSION = 1;
/** The local schema version these backups describe (the highest migration number). */
export const LOCAL_SCHEMA_VERSION = 7;

type Row = Record<string, unknown>;
type Cell = string | number | null;

/** Tables restored in this order (parents before children, so foreign keys always resolve). */
export const BACKUP_TABLES = [
  "settings", "accounts", "merchants", "projects", "tags", "recurring_rules", "statements", "transactions", "transaction_tags", "transaction_links",
  "custom_categories", "category_meta", "merchant_rules", "budgets", "import_templates", "organize_runs", "audit_events",
] as const;

/** Settings that describe the device copy, not the book: never restored (a restored copy gets its own). */
const DEVICE_SETTINGS = new Set(["report_id", "owner_account_id", "web_sync_version", "web_sync_checked_at", "last_synced_at", "audit_purge", "web_sync_skip"]);

export interface BackupManifest {
  rows: Record<string, number>;
  /** Σ transactions.amount_cents (live and trashed) and Σ accounts.opening_balance_cents. */
  transactionsAmountCents: number;
  openingBalancesCents: number;
}

export interface BackupContent {
  format: typeof BACKUP_FORMAT;
  version: number;
  schemaVersion: number;
  createdAt: string;
  book: { uuid: string | null; name: string | null; currency: string | null };
  tables: Record<string, { columns: string[]; rows: Cell[][] }>;
  manifest: BackupManifest;
  /** SHA-256 (hex) of JSON.stringify(tables). */
  checksum: string;
}

export interface EncryptedBackup {
  format: typeof BACKUP_FORMAT;
  version: number;
  encrypted: true;
  kdf: { name: "PBKDF2"; hash: "SHA-256"; iterations: number; salt: string };
  cipher: { name: "AES-GCM"; iv: string };
  data: string;
}

export type BackupErrorCode = "not_a_backup" | "newer_version" | "passphrase_required" | "wrong_passphrase" | "damaged" | "target_not_empty" | "verify_failed";

export class BackupError extends Error {
  constructor(public code: BackupErrorCode, message: string) {
    super(message);
    this.name = "BackupError";
  }
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const hex = (bytes: ArrayBuffer) => [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");
const sha256 = async (text: string) => hex(await crypto.subtle.digest("SHA-256", encoder.encode(text)));
const b64 = (bytes: Uint8Array) => {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
};
const unb64 = (text: string) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));

async function tableNames(db: SqlDriver): Promise<Set<string>> {
  const rows = await db.select<Row>("SELECT name FROM sqlite_master WHERE type = 'table'");
  return new Set(rows.map((row) => String(row.name)));
}

async function columnsOf(db: SqlDriver, table: string): Promise<string[]> {
  return (await db.select<Row>(`SELECT name FROM pragma_table_info('${table}')`)).map((row) => String(row.name));
}

/** Counts and totals that a restore must reproduce exactly. */
export async function manifestOf(db: SqlDriver): Promise<BackupManifest> {
  const existing = await tableNames(db);
  const rows: Record<string, number> = {};
  for (const table of BACKUP_TABLES) {
    if (!existing.has(table)) continue;
    const [count] = await db.select<Row>(`SELECT COUNT(*) AS n FROM ${table}${table === "settings" ? ` WHERE key NOT IN (${[...DEVICE_SETTINGS].map((k) => `'${k}'`).join(", ")})` : ""}`);
    rows[table] = Number(count.n);
  }
  const [sums] = await db.select<Row>(`SELECT (SELECT COALESCE(SUM(amount_cents), 0) FROM transactions) AS tx${existing.has("accounts") ? ", (SELECT COALESCE(SUM(opening_balance_cents), 0) FROM accounts) AS opening" : ""}`);
  return { rows, transactionsAmountCents: Number(sums.tx), openingBalancesCents: Number(sums.opening ?? 0) };
}

/** Reads the whole database into a backup document (in memory). */
export async function createBackup(db: SqlDriver): Promise<BackupContent> {
  const existing = await tableNames(db);
  const tables: BackupContent["tables"] = {};
  for (const table of BACKUP_TABLES) {
    if (!existing.has(table)) continue;
    const columns = await columnsOf(db, table);
    const rows = await db.select<Row>(`SELECT * FROM ${table}${table === "settings" ? ` WHERE key NOT IN (${[...DEVICE_SETTINGS].map((k) => `'${k}'`).join(", ")})` : ""} ORDER BY rowid`);
    tables[table] = { columns, rows: rows.map((row) => columns.map((column) => (row[column] === undefined ? null : (row[column] as Cell)))) };
  }
  const setting = (key: string) => {
    const found = tables.settings?.rows.find((row) => row[0] === key);
    return found ? String(found[1]) : null;
  };
  return {
    format: BACKUP_FORMAT, version: BACKUP_VERSION, schemaVersion: LOCAL_SCHEMA_VERSION, createdAt: new Date().toISOString(),
    book: { uuid: setting("book_uuid"), name: setting("database_name"), currency: setting("currency") },
    tables, manifest: await manifestOf(db), checksum: await sha256(JSON.stringify(tables)),
  };
}

const ITERATIONS = 310_000;

async function keyFrom(passphrase: string, salt: Uint8Array, iterations: number): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey("raw", encoder.encode(passphrase), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey({ name: "PBKDF2", hash: "SHA-256", salt: salt as BufferSource, iterations }, material, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}

/** The bytes of a backup file: plain JSON, or encrypted when a passphrase is given. */
export async function serializeBackup(content: BackupContent, passphrase?: string | null): Promise<Uint8Array> {
  const json = JSON.stringify(content);
  if (!passphrase) return encoder.encode(json);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await keyFrom(passphrase, salt, ITERATIONS);
  const data = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: iv as BufferSource }, key, encoder.encode(json)));
  const wrapped: EncryptedBackup = {
    format: BACKUP_FORMAT, version: BACKUP_VERSION, encrypted: true,
    kdf: { name: "PBKDF2", hash: "SHA-256", iterations: ITERATIONS, salt: b64(salt) }, cipher: { name: "AES-GCM", iv: b64(iv) }, data: b64(data),
  };
  return encoder.encode(JSON.stringify(wrapped));
}

/** Whether a file needs a passphrase (without reading its content). */
export function isEncryptedBackup(bytes: Uint8Array): boolean {
  try {
    const parsed = JSON.parse(decoder.decode(bytes)) as Partial<EncryptedBackup>;
    return parsed.format === BACKUP_FORMAT && parsed.encrypted === true;
  } catch {
    return false;
  }
}

/** Parses, decrypts and verifies a backup file. Throws BackupError. */
export async function readBackup(bytes: Uint8Array, passphrase?: string | null): Promise<BackupContent> {
  let parsed: Partial<BackupContent & EncryptedBackup>;
  try {
    parsed = JSON.parse(decoder.decode(bytes)) as Partial<BackupContent & EncryptedBackup>;
  } catch {
    throw new BackupError("not_a_backup", "This is not a BillieWeather backup file.");
  }
  if (parsed.format !== BACKUP_FORMAT) throw new BackupError("not_a_backup", "This is not a BillieWeather backup file.");
  if (Number(parsed.version) > BACKUP_VERSION) throw new BackupError("newer_version", "This backup was made by a newer version of BillieWeather.");
  if (parsed.encrypted) {
    if (!passphrase) throw new BackupError("passphrase_required", "Enter the backup's passphrase.");
    try {
      const key = await keyFrom(passphrase, unb64(parsed.kdf!.salt), parsed.kdf!.iterations);
      const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(parsed.cipher!.iv) as BufferSource }, key, unb64(parsed.data!) as BufferSource);
      parsed = JSON.parse(decoder.decode(plain)) as Partial<BackupContent>;
    } catch {
      throw new BackupError("wrong_passphrase", "The passphrase is not right, or the file is damaged.");
    }
  }
  const content = parsed as BackupContent;
  if (!content.tables || !content.manifest || typeof content.checksum !== "string") throw new BackupError("damaged", "The backup file is incomplete.");
  if (Number(content.schemaVersion) > LOCAL_SCHEMA_VERSION) throw new BackupError("newer_version", "This backup was made by a newer version of BillieWeather.");
  if ((await sha256(JSON.stringify(content.tables))) !== content.checksum) throw new BackupError("damaged", "The backup file has been changed or damaged.");
  return content;
}

/**
 * Writes a verified backup into an EMPTY database (a new slot). Device-specific settings are not
 * restored; `owner` becomes the new copy's owner. After writing, counts and totals are compared with
 * the manifest: on any difference the database is emptied again and BackupError("verify_failed") is thrown.
 */
export async function restoreInto(db: SqlDriver, content: BackupContent, options: { owner?: string | null; name?: string | null } = {}): Promise<BackupManifest> {
  const [used] = await db.select<Row>("SELECT (SELECT COUNT(*) FROM transactions) + (SELECT COUNT(*) FROM statements) + (SELECT COUNT(*) FROM accounts) AS n");
  if (Number(used.n) > 0) throw new BackupError("target_not_empty", "Backups are restored into a new, empty database only.");
  const existing = await tableNames(db);
  try {
    for (const table of BACKUP_TABLES) {
      const data = content.tables[table];
      if (!data || !existing.has(table) || data.rows.length === 0) continue;
      const target = new Set(await columnsOf(db, table));
      const keep = data.columns.map((column, index) => ({ column, index })).filter(({ column }) => target.has(column));
      let rows = data.rows;
      if (table === "settings") rows = rows.filter((row) => !DEVICE_SETTINGS.has(String(row[0])));
      // statements_commit_staged fires on statements with an import batch: write it after the row exists.
      const batchIndex = table === "statements" ? data.columns.indexOf("import_batch_id") : -1;
      const perBatch = Math.max(1, Math.floor(900 / Math.max(1, keep.length)));
      for (let start = 0; start < rows.length; start += perBatch) {
        const batch = rows.slice(start, start + perBatch);
        const params: unknown[] = [];
        for (const row of batch) for (const { column, index } of keep) params.push(table === "statements" && column === "import_batch_id" ? null : row[index]);
        await db.execute(`INSERT INTO ${table} (${keep.map(({ column }) => column).join(", ")}) VALUES ${batch.map(() => `(${keep.map(() => "?").join(", ")})`).join(", ")}`, params);
      }
      if (batchIndex >= 0) {
        const idIndex = data.columns.indexOf("id");
        for (const row of rows) if (row[batchIndex] !== null) await db.execute("UPDATE statements SET import_batch_id = ? WHERE id = ?", [row[batchIndex], row[idIndex]]);
      }
    }
    const stamp = new Date().toISOString();
    if (options.owner) await db.execute("INSERT INTO settings (key, value) VALUES ('owner_account_id', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value", [options.owner]);
    if (options.name) await db.execute("INSERT INTO settings (key, value) VALUES ('database_name', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value", [options.name]);
    const restored = await manifestOf(db);
    const expected = content.manifest;
    const sameRows = Object.entries(expected.rows).every(([table, count]) => table === "settings" || !existing.has(table) || restored.rows[table] === count);
    if (!sameRows || restored.transactionsAmountCents !== expected.transactionsAmountCents || restored.openingBalancesCents !== expected.openingBalancesCents) {
      throw new BackupError("verify_failed", "The restored copy does not match the backup.");
    }
    await db.execute("INSERT INTO audit_events (uuid, at, actor, action, subject_type, subject_id, summary) VALUES (?, ?, 'user', 'restore_backup', 'book', ?, ?)",
      [randomId(), stamp, content.book.uuid, `backup of ${content.createdAt}`]);
    return restored;
  } catch (error) {
    // Leave the new slot empty again; the original database was never touched.
    await db.execute("INSERT INTO settings (key, value) VALUES ('audit_purge', '1') ON CONFLICT (key) DO UPDATE SET value = '1'").catch(() => undefined);
    for (const table of [...BACKUP_TABLES].reverse()) if (existing.has(table) && table !== "settings") await db.execute(`DELETE FROM ${table}`).catch(() => undefined);
    await db.execute("DELETE FROM settings").catch(() => undefined);
    throw error instanceof BackupError ? error : new BackupError("verify_failed", `The backup could not be restored: ${String((error as Error)?.message ?? error)}`);
  }
}

/** A file name for a backup of this book on this date. */
export function backupFileName(name: string | null, date = new Date()): string {
  const safe = (name ?? "book").replace(/[^\p{L}\p{N}_-]+/gu, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "book";
  return `billieweather-backup-${safe}-${date.toISOString().slice(0, 10)}.bwbackup`;
}
