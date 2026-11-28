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
import type { SqlDriver, SqlStatement } from "./store";
import { randomId } from "./ids";
import { LOCAL_SCHEMA_VERSION } from "./migrations";

export const BACKUP_FORMAT = "billieweather-backup";
export const BACKUP_VERSION = 1;
/** The local schema version these backups describe: derived from the migration files (migrations.ts). */
export { LOCAL_SCHEMA_VERSION };

type Row = Record<string, unknown>;
type Cell = string | number | null;

/** Tables restored in this order (parents before children, so foreign keys always resolve). */
export const BACKUP_TABLES = [
  "settings", "accounts", "merchants", "projects", "tags", "recurring_rules", "statements", "transactions", "transaction_tags", "transaction_links",
  "custom_categories", "category_meta", "categories", "merchant_rules", "budgets", "import_templates", "organize_runs", "audit_events",
] as const;

/**
 * What migration 0011 does to a book from before the category tree, for restoring such a backup into a
 * current database: the nine old built-ins (when the book is in use), the custom categories with their old
 * parent, kind, order and hidden settings, and `category_seed` = legacy. Keep in step with the migration.
 */
const LEGACY_CATEGORY_STATEMENTS: readonly SqlStatement[] = [
  { sql: `WITH legacy (name, system_key, kind, position) AS (VALUES
      ('Income', 'income', 'income', 0), ('Housing', 'housing', 'expense', 1), ('Food & dining', 'food', 'expense', 2),
      ('Transport', 'transport', 'expense', 3), ('Utilities', 'utilities', 'expense', 4), ('Shopping', 'shopping', 'expense', 5),
      ('Health', 'health', 'expense', 6), ('Business', 'business', 'expense', 7), ('Transfers', 'transfers', 'transfer', 8))
    INSERT INTO categories (name, parent, system_key, kind, sort_order, hidden, created_at, updated_at)
      SELECT l.name, NULL, l.system_key, l.kind, COALESCE(m.sort_order, 1000 + l.position), COALESCE(m.hidden, 0), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      FROM legacy l LEFT JOIN category_meta m ON m.name = l.name
      WHERE EXISTS (SELECT 1 FROM transactions) OR EXISTS (SELECT 1 FROM custom_categories) OR EXISTS (SELECT 1 FROM category_meta)
        OR EXISTS (SELECT 1 FROM merchant_rules) OR EXISTS (SELECT 1 FROM budgets)
      ORDER BY l.position` },
  { sql: `WITH legacy (name) AS (VALUES ('Income'), ('Housing'), ('Food & dining'), ('Transport'), ('Utilities'), ('Shopping'), ('Health'), ('Business'), ('Transfers')),
    custom AS (SELECT name, created_at, ROW_NUMBER() OVER (ORDER BY name COLLATE NOCASE) - 1 AS position FROM custom_categories),
    placed AS (
      SELECT c.name, c.created_at, c.position, m.sort_order, m.hidden, m.category_kind, pl.name AS legacy_parent, pm.category_kind AS parent_kind,
        CASE WHEN m.parent IS NOT NULL AND lower(m.parent) <> lower(c.name)
          AND ((pl.name IS NOT NULL AND pl.name <> 'Transfers') OR (pc.name IS NOT NULL AND pm.parent IS NULL)) THEN COALESCE(pl.name, pc.name) END AS parent
      FROM custom c LEFT JOIN category_meta m ON m.name = c.name LEFT JOIN legacy pl ON lower(pl.name) = lower(m.parent)
      LEFT JOIN custom_categories pc ON pc.name = m.parent LEFT JOIN category_meta pm ON pm.name = m.parent)
    INSERT OR IGNORE INTO categories (name, parent, system_key, kind, sort_order, hidden, created_at, updated_at)
      SELECT name, parent, NULL,
        CASE WHEN parent IS NULL THEN COALESCE(category_kind, 'expense') WHEN legacy_parent = 'Income' THEN 'income' WHEN legacy_parent IS NOT NULL THEN 'expense' ELSE COALESCE(parent_kind, 'expense') END,
        COALESCE(sort_order, 1010 + position), COALESCE(hidden, 0), created_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      FROM placed ORDER BY position` },
  { sql: "UPDATE categories SET parent = NULL WHERE parent IS NOT NULL AND NOT EXISTS (SELECT 1 FROM categories p WHERE p.name = categories.parent)" },
  { sql: "INSERT INTO settings (key, value) SELECT 'category_seed', 'legacy' WHERE EXISTS (SELECT 1 FROM categories)" },
];

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

export type BackupErrorCode = "not_a_backup" | "newer_version" | "passphrase_required" | "wrong_passphrase" | "damaged" | "target_not_empty" | "verify_failed" | "other_account";

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
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const safeInteger = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value);

/** Validate before any write, even when an internal caller did not use readBackup. */
async function verifyContent(value: unknown): Promise<BackupContent> {
  if (!record(value) || value.format !== BACKUP_FORMAT) throw new BackupError("not_a_backup", "This is not a BillieWeather backup file.");
  if (Number(value.version) > BACKUP_VERSION || Number(value.schemaVersion) > LOCAL_SCHEMA_VERSION) throw new BackupError("newer_version", "This backup was made by a newer version of BillieWeather.");
  const damaged = () => new BackupError("damaged", "The backup file is incomplete or damaged.");
  if (value.version !== BACKUP_VERSION || !safeInteger(value.schemaVersion) || value.schemaVersion < 1 || !record(value.tables) || !record(value.manifest) || !record(value.book) ||
      typeof value.createdAt !== "string" || !Number.isFinite(Date.parse(value.createdAt)) || typeof value.checksum !== "string") throw damaged();
  const manifest = value.manifest;
  if (!record(manifest.rows) || !safeInteger(manifest.transactionsAmountCents) || !safeInteger(manifest.openingBalancesCents)) throw damaged();
  for (const [name, table] of Object.entries(value.tables)) {
    if (!(BACKUP_TABLES as readonly string[]).includes(name) || !record(table) || !Array.isArray(table.columns) || !Array.isArray(table.rows)) throw damaged();
    const columns = table.columns;
    if (columns.length === 0 || !columns.every((column) => typeof column === "string") || new Set(columns).size !== columns.length) throw damaged();
    if (!table.rows.every((row) => Array.isArray(row) && row.length === columns.length && row.every((cell) => cell === null || typeof cell === "string" || (typeof cell === "number" && Number.isFinite(cell))))) throw damaged();
    const moneyColumns = columns.flatMap((column, index) => String(column).endsWith("_cents") ? [index] : []);
    if (table.rows.some((row) => moneyColumns.some((index) => row[index] !== null && !safeInteger(row[index])))) throw damaged();
    if (manifest.rows[name] !== table.rows.length) throw damaged();
  }
  if (!["settings", "statements", "transactions"].every((name) => Object.hasOwn(value.tables as object, name)) ||
      Object.keys(manifest.rows).some((name) => !Object.hasOwn(value.tables as object, name))) throw damaged();
  if ((await sha256(JSON.stringify(value.tables))) !== value.checksum) throw damaged();
  return value as unknown as BackupContent;
}

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

/**
 * Reads the whole database into a backup document (in memory). Every table is read in ONE read
 * transaction (`SqlDriver.snapshot`), so the document describes a single instant: an entry, its
 * links, its tags and its audit events always belong together, even while a background download
 * or a recurring entry is being written.
 */
export async function createBackup(db: SqlDriver): Promise<BackupContent> {
  const existing = await tableNames(db);
  const names = BACKUP_TABLES.filter((table) => existing.has(table));
  const columns = await Promise.all(names.map((table) => columnsOf(db, table)));
  const captured = await db.snapshot<Row>(names.map((table) => ({
    sql: `SELECT * FROM ${table}${table === "settings" ? ` WHERE key NOT IN (${[...DEVICE_SETTINGS].map((k) => `'${k}'`).join(", ")})` : ""} ORDER BY rowid`,
  })));
  const tables: BackupContent["tables"] = {};
  names.forEach((table, index) => {
    tables[table] = { columns: columns[index], rows: captured[index].map((row) => columns[index].map((column) => (row[column] === undefined ? null : (row[column] as Cell)))) };
  });
  const setting = (key: string) => {
    const found = tables.settings?.rows.find((row) => row[0] === key);
    return found ? String(found[1]) : null;
  };
  return {
    format: BACKUP_FORMAT, version: BACKUP_VERSION, schemaVersion: LOCAL_SCHEMA_VERSION, createdAt: new Date().toISOString(),
    book: { uuid: setting("book_uuid"), name: setting("database_name"), currency: setting("currency") },
    // Compute the manifest from the captured rows, rather than a second read that can disagree
    // when background sync changes the database while the backup is being assembled.
    tables, manifest: {
      rows: Object.fromEntries(Object.entries(tables).map(([name, table]) => [name, table.rows.length])),
      transactionsAmountCents: tables.transactions.rows.reduce((sum, row) => sum + Number(row[tables.transactions.columns.indexOf("amount_cents")]), 0),
      openingBalancesCents: tables.accounts?.rows.reduce((sum, row) => sum + Number(row[tables.accounts.columns.indexOf("opening_balance_cents")]), 0) ?? 0,
    }, checksum: await sha256(JSON.stringify(tables)),
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
  if (!record(parsed) || parsed.format !== BACKUP_FORMAT) throw new BackupError("not_a_backup", "This is not a BillieWeather backup file.");
  if (Number(parsed.version) > BACKUP_VERSION) throw new BackupError("newer_version", "This backup was made by a newer version of BillieWeather.");
  if (parsed.encrypted) {
    if (parsed.version !== BACKUP_VERSION || parsed.kdf?.name !== "PBKDF2" || parsed.kdf.hash !== "SHA-256" || !safeInteger(parsed.kdf.iterations) ||
        parsed.kdf.iterations < 100_000 || parsed.kdf.iterations > 1_000_000 || parsed.cipher?.name !== "AES-GCM" ||
        typeof parsed.kdf.salt !== "string" || typeof parsed.cipher.iv !== "string" || typeof parsed.data !== "string") {
      throw new BackupError("damaged", "The encrypted backup header is invalid.");
    }
    if (!passphrase) throw new BackupError("passphrase_required", "Enter the backup's passphrase.");
    try {
      const salt = unb64(parsed.kdf.salt);
      const iv = unb64(parsed.cipher.iv);
      if (salt.length !== 16 || iv.length !== 12) throw new Error("invalid encryption parameters");
      const key = await keyFrom(passphrase, salt, parsed.kdf.iterations);
      const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: iv as BufferSource }, key, unb64(parsed.data) as BufferSource);
      parsed = JSON.parse(decoder.decode(plain)) as Partial<BackupContent>;
    } catch {
      throw new BackupError("wrong_passphrase", "The passphrase is not right, or the file is damaged.");
    }
  }
  return verifyContent(parsed);
}

/**
 * Writes a verified backup into an EMPTY database (a new slot). Device-specific settings are not
 * restored; `owner` becomes the new copy's owner. After writing, counts and totals are compared with
 * the manifest: on any difference the database is emptied again and BackupError("verify_failed") is thrown.
 */
export async function restoreInto(db: SqlDriver, content: BackupContent, options: { owner?: string | null; name?: string | null } = {}): Promise<BackupManifest> {
  content = await verifyContent(content);
  const existing = await tableNames(db);
  // A new slot may already hold the default categories it was seeded with when it opened: not content.
  const seeded = (await db.select<Row>("SELECT value FROM settings WHERE key = 'category_seed'"))[0]?.value === "defaults";
  const setup = new Set([...DEVICE_SETTINGS, ...(seeded ? ["category_seed"] : [])]);
  for (const table of BACKUP_TABLES) {
    if (!existing.has(table)) continue;
    const where = table === "settings" ? ` WHERE key NOT IN (${[...setup].map(() => "?").join(", ")})` : table === "categories" && seeded ? " WHERE system_key IS NULL" : "";
    const used = await db.select<Row>(`SELECT 1 FROM ${table}${where} LIMIT 1`, table === "settings" ? [...setup] : []);
    if (used.length) throw new BackupError("target_not_empty", "Backups are restored into a new, empty database only.");
  }
  // Schema compatibility is checked before inserting anything; silently discarding a column or
  // table could lose financial evidence while still producing matching row counts and sums.
  for (const [table, data] of Object.entries(content.tables)) {
    const target = new Set(existing.has(table) ? await columnsOf(db, table) : []);
    if (data.columns.some((column) => !target.has(column))) throw new BackupError("damaged", "The backup schema is not supported.");
  }
  // Everything below is ONE database transaction, including the verification: the new slot ends
  // up holding exactly the backup, or nothing at all. There is no half-restored state to clean up.
  // The seeded defaults make way for the backup's own categories.
  const statements: SqlStatement[] = existing.has("categories") ? [{ sql: "DELETE FROM categories" }, { sql: "DELETE FROM settings WHERE key = 'category_seed'" }] : [];
  for (const table of BACKUP_TABLES) {
    const data = content.tables[table];
    if (!data || !existing.has(table) || data.rows.length === 0) continue;
    const target = new Set(await columnsOf(db, table));
    const keep = data.columns.map((column, index) => ({ column, index })).filter(({ column }) => target.has(column));
    let rows = data.rows;
    if (table === "settings") rows = rows.filter((row) => !DEVICE_SETTINGS.has(String(row[data.columns.indexOf("key")])));
    const perBatch = Math.max(1, Math.floor(900 / Math.max(1, keep.length)));
    for (let start = 0; start < rows.length; start += perBatch) {
      const batch = rows.slice(start, start + perBatch);
      const params: unknown[] = [];
      for (const row of batch) for (const { column, index } of keep) params.push(deferred(table, column) ? DEFERRED[table][column] : row[index]);
      statements.push({ sql: `INSERT INTO ${table} (${keep.map(({ column }) => column).join(", ")}) VALUES ${batch.map(() => `(${keep.map(() => "?").join(", ")})`).join(", ")}`, params });
    }
    // A restore copies rows; it must not run the triggers that belong to creating them. The columns
    // those triggers watch are written neutral above and set to the backed-up value here.
    const idIndex = data.columns.indexOf("id");
    for (const column of Object.keys(DEFERRED[table] ?? {})) {
      const index = data.columns.indexOf(column);
      if (index < 0 || idIndex < 0 || TRANSIENT[table]?.has(column)) continue;
      for (const row of rows) {
        if (row[index] !== DEFERRED[table][column]) statements.push({ sql: `UPDATE ${table} SET ${column} = ? WHERE id = ?`, params: [row[index], row[idIndex]] });
      }
    }
  }
  // A backup from before the category tree (schema 10 and older): the book keeps exactly the categories it had.
  if (existing.has("categories") && !content.tables.categories) statements.push(...LEGACY_CATEGORY_STATEMENTS);
  if (options.owner) statements.push({ sql: "INSERT INTO settings (key, value) VALUES ('owner_account_id', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value", params: [options.owner] });
  if (options.name) statements.push({ sql: "INSERT INTO settings (key, value) VALUES ('database_name', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value", params: [options.name] });
  const expected = content.manifest;
  for (const [table, count] of Object.entries(expected.rows)) {
    if (table !== "settings" && existing.has(table)) statements.push(assertion(`(SELECT COUNT(*) FROM ${table}) = ?`, [count]));
  }
  statements.push(assertion("(SELECT COALESCE(SUM(amount_cents), 0) FROM transactions) = ?", [expected.transactionsAmountCents]));
  if (existing.has("accounts")) statements.push(assertion("(SELECT COALESCE(SUM(opening_balance_cents), 0) FROM accounts) = ?", [expected.openingBalancesCents]));
  statements.push(assertion("NOT EXISTS (SELECT 1 FROM pragma_foreign_key_check)"));
  statements.push({ sql: "INSERT INTO audit_events (uuid, at, actor, action, subject_type, subject_id, summary) VALUES (?, ?, 'user', 'restore_backup', 'book', ?, ?)",
    params: [randomId(), new Date().toISOString(), content.book.uuid, `backup of ${content.createdAt}`] });
  try {
    await db.transaction(statements);
  } catch (error) {
    // Rolled back: the new slot is still empty and the original database was never touched.
    throw new BackupError("verify_failed", /restore_verification/.test(String((error as Error)?.message ?? error))
      ? "The restored copy does not match the backup."
      : `The backup could not be restored: ${String((error as Error)?.message ?? error)}`);
  }
  // What was restored: the restore's own log entry (written last, above) is not part of the backup.
  const restored = await manifestOf(db);
  return { ...restored, rows: { ...restored.rows, audit_events: restored.rows.audit_events - 1 } };
}

/**
 * Columns a restore writes in two steps, with the neutral value used for the INSERT:
 * - `statements.import_batch_id` fires the import commit trigger (migration 0004), which expects staged rows;
 * - a confirmed `refund_of` link fires the refund guards (migration 0008), which belong to creating a
 *   link, not to copying one: a faithful copy of a book must restore whatever it held;
 * - `transactions.link_group` / `link_hint` / `link_target_id` are insert-time helpers that create
 *   links (migration 0007). They carry no information at rest, so they are restored empty.
 */
const DEFERRED: Record<string, Record<string, Cell>> = {
  statements: { import_batch_id: null },
  transaction_links: { status: "suggested" },
  transactions: { link_group: null, link_hint: null, link_target_id: null },
};
const TRANSIENT: Record<string, Set<string>> = { transactions: new Set(["link_group", "link_hint", "link_target_id"]) };
const deferred = (table: string, column: string) => Object.hasOwn(DEFERRED[table] ?? {}, column);

/**
 * A statement that fails (and so rolls the whole restore back) unless `condition` holds:
 * `settings.key` is NOT NULL, so selecting a NULL key into it is refused by SQLite itself.
 */
const assertion = (condition: string, params: unknown[] = []): SqlStatement => ({
  sql: `INSERT INTO settings (key, value) SELECT NULL, 'restore_verification' WHERE NOT (${condition})`, params,
});

/** A file name for a backup of this book on this date. */
export function backupFileName(name: string | null, date = new Date()): string {
  const safe = (name ?? "book").replace(/[^\p{L}\p{N}_-]+/gu, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "book";
  return `billieweather-backup-${safe}-${date.toISOString().slice(0, 10)}.bwbackup`;
}
