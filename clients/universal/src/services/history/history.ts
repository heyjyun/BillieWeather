// Undo and Redo of a person's edits (docs/architecture/editing-history.md).
//
// An edit is recorded by the database itself: the first statement of its transaction opens a history group,
// the capture triggers of migration 0010 note every row the transaction touches, and its last statements note
// what the rows have become and close the group. Undo writes the rows of the newest group back as they were,
// Redo writes them forward again; each is ONE transaction that aborts unless every row is exactly what the
// group left behind, and unless the result is exactly what it should be. Nothing is merged or guessed.
import { randomId } from "../ids";
import type { SqlDriver, SqlStatement } from "../store";
import { HISTORY_TABLES, imageSql, keySql, type HistoryTable } from "./tables";

/** What an edit was, for its name in the interface (i18n: history.actions). */
export const HISTORY_ACTIONS = [
  "create", "edit", "category", "kind", "exclude", "batch_edit", "delete", "restore", "duplicate", "link", "import", "reverse_import", "reclassify", "organize", "organize_undo",
  "account", "balance", "category_list", "label_list", "budget", "schedule", "post_schedule", "rule", "region", "settings", "command_undo",
] as const;
export type HistoryAction = (typeof HISTORY_ACTIONS)[number];

/** How many edits can be undone, and how many row images they may hold together (the newest edit always stays). */
export const HISTORY_GROUPS = 100;
export const HISTORY_ROWS = 60_000;
/** Undoing or redoing this many entries at once is asked about first. */
export const HISTORY_CONFIRM = 25;

export interface HistoryEntry {
  id: number;
  at: string;
  action: HistoryAction;
  /** Entries (transactions) it touched, and their text when they share one. */
  entries: number;
  description: string | null;
}

export interface HistoryState {
  undo: HistoryEntry | null;
  redo: HistoryEntry | null;
}

/** `conflict`: something it touched was changed by something else since, so it is dropped and nothing was written. */
export type HistoryOutcome = "done" | "conflict" | "gone";
export type HistoryDirection = "undo" | "redo";

type Row = Record<string, unknown>;
const now = () => new Date().toISOString();

/** `c` (history_changes) names row `row` of the table. Integer ids use the primary key's index. */
const matches = (table: HistoryTable, row: string, change: string) =>
  table.key.map((column, index) => `${row}.${column} = json_extract(${change}.row_key, '$[${index}]')${table.integer ? "" : " COLLATE BINARY"}`).join(" AND ");

// ------------------------------------------------------------------------------------------- recording

function openStatements(uuid: string, action: HistoryAction): SqlStatement[] {
  return [
    { sql: "INSERT INTO history_groups (uuid, at, action) SELECT ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM history_groups WHERE uuid = ?)", params: [uuid, now(), action, uuid] },
    { sql: "UPDATE history_state SET group_id = (SELECT id FROM history_groups WHERE uuid = ?) WHERE id = 1", params: [uuid] },
  ];
}

const closeStatements: readonly SqlStatement[] = [
  ...HISTORY_TABLES.map((table) => ({
    sql: `UPDATE history_changes SET after_image = (SELECT ${imageSql(table, "r")} FROM ${table.name} r WHERE ${matches(table, "r", "history_changes")})
      WHERE group_id = (SELECT group_id FROM history_state WHERE id = 1) AND table_name = '${table.name}'`,
  })),
  // Rows that ended as they began are no change; an edit without any change is no edit.
  { sql: "DELETE FROM history_changes WHERE group_id = (SELECT group_id FROM history_state WHERE id = 1) AND before_image IS after_image" },
  // A new edit ends what could be redone.
  { sql: "DELETE FROM history_changes WHERE group_id IN (SELECT id FROM history_groups WHERE undone_at IS NOT NULL) AND EXISTS (SELECT 1 FROM history_changes WHERE group_id = (SELECT group_id FROM history_state WHERE id = 1))" },
  { sql: "DELETE FROM history_groups WHERE NOT EXISTS (SELECT 1 FROM history_changes WHERE group_id = history_groups.id)" },
  {
    sql: `DELETE FROM history_changes WHERE group_id IN (
        SELECT id FROM (SELECT g.id, ROW_NUMBER() OVER (ORDER BY g.id DESC) AS place,
            SUM((SELECT COUNT(*) FROM history_changes c WHERE c.group_id = g.id)) OVER (ORDER BY g.id DESC) AS held FROM history_groups g)
        WHERE place > ${HISTORY_GROUPS} OR (held > ${HISTORY_ROWS} AND place > 1))`,
  },
  { sql: "DELETE FROM history_groups WHERE NOT EXISTS (SELECT 1 FROM history_changes WHERE group_id = history_groups.id)" },
  { sql: "UPDATE history_state SET group_id = NULL WHERE id = 1" },
];

/** A driver whose every write belongs to one history group. Reads go straight through. */
export function recordingDriver(db: SqlDriver, action: HistoryAction): SqlDriver {
  const uuid = randomId();
  const transaction: SqlDriver["transaction"] = async (statements) => {
    const open = openStatements(uuid, action);
    const results = await db.transaction([...open, ...statements, ...closeStatements]);
    return results.slice(open.length, open.length + statements.length);
  };
  return {
    transaction,
    execute: async (sql, params) => (await transaction([{ sql, params }]))[0],
    select: (sql, params) => db.select(sql, params),
    snapshot: (queries) => db.snapshot(queries),
  };
}

/** Empties the history (part of "Delete everything"): run these before the book's own tables are emptied. */
export const CLEAR_HISTORY: readonly SqlStatement[] = [{ sql: "DELETE FROM history_changes" }, { sql: "DELETE FROM history_groups" }];

// --------------------------------------------------------------------------------------------- replay

/** Fails the transaction (CHECK history_conflict) when `count` finds anything. */
const refuseIf = (count: string, params: unknown[] = []): SqlStatement => ({ sql: `UPDATE history_state SET conflict = (${count}) WHERE id = 1`, params });

const BROKEN_REFERENCES = "SELECT COUNT(*) FROM pragma_foreign_key_check";

export function replayStatements(group: number, direction: HistoryDirection): SqlStatement[] {
  const [from, to] = direction === "undo" ? ["after_image", "before_image"] : ["before_image", "after_image"];
  const stamp = now();
  const changes = (table: HistoryTable, extra = "") => `c.group_id = ${group} AND c.table_name = '${table.name}'${extra}`;
  const current = (table: HistoryTable) => `CASE WHEN r.${table.key[0]} IS NULL THEN NULL ELSE ${imageSql(table, "r")} END`;
  const onRow = (table: HistoryTable) => `history_changes c LEFT JOIN ${table.name} r ON ${matches(table, "r", "c")}`;
  const gone = (table: HistoryTable) => `(SELECT json_extract(c.row_key, '$[0]') FROM history_changes c WHERE ${changes(table, ` AND c.${to} IS NULL`)})`;
  const touched = (table: HistoryTable) => table.excluded.includes("updated_at");
  const table = (name: string) => HISTORY_TABLES.find((item) => item.name === name)!;
  // Rows an undo would remove although something outside this edit uses them by now stay; only as a side
  // effect of entries, never when creating them was the edit itself.
  const kept = (item: HistoryTable) => item.usedBy
    ? ` AND NOT (c.${to} IS NULL AND (${item.usedBy.replaceAll("ROW", "r")}) AND EXISTS (SELECT 1 FROM history_changes e WHERE e.group_id = ${group} AND e.table_name = 'transactions'))`
    : "";
  const remove = (item: HistoryTable): SqlStatement => ({
    sql: `DELETE FROM ${item.name} WHERE ${item.usedBy ? `NOT (${item.usedBy.replaceAll("ROW", item.name)}) AND ` : ""}${item.integer ? `id IN ${gone(item)}` : `${keySql(item, item.name)} IN (SELECT c.row_key FROM history_changes c WHERE ${changes(item, ` AND c.${to} IS NULL`)})`}`,
  });
  const insert = (item: HistoryTable): SqlStatement => {
    // A re-inserted statement must not start an import again (trigger statements_commit_staged): its batch id follows.
    const columns = item.columns.filter((column) => !(item.name === "statements" && column === "import_batch_id"));
    return {
      sql: `INSERT INTO ${item.name} (${[...columns, ...(touched(item) ? ["updated_at"] : [])].join(", ")})
        SELECT ${[...columns.map((column) => `json_extract(c.${to}, '$.${column}')`), ...(touched(item) ? ["?"] : [])].join(", ")} FROM ${onRow(item)}
        WHERE ${changes(item, ` AND c.${to} IS NOT NULL AND r.${item.key[0]} IS NULL`)} ORDER BY c.id`,
      params: touched(item) ? [stamp] : [],
    };
  };
  const update = (item: HistoryTable): SqlStatement | null => {
    const columns = item.columns.filter((column) => !item.key.includes(column));
    if (columns.length === 0) return null;
    return {
      sql: `UPDATE ${item.name} SET ${[...columns.map((column) => `${column} = json_extract(c.${to}, '$.${column}')`), ...(touched(item) ? ["updated_at = ?"] : [])].join(", ")}
        FROM history_changes c WHERE ${changes(item, ` AND c.${to} IS NOT NULL`)} AND ${matches(item, item.name, "c")} AND ${imageSql(item, item.name)} IS NOT c.${to}`,
      params: touched(item) ? [stamp] : [],
    };
  };
  const parents = ["settings", "accounts", "merchants", "projects", "tags", "recurring_rules", "custom_categories", "category_meta", "merchant_rules", "statements", "organize_runs"].map(table);
  const lists = ["custom_categories", "category_meta", "merchant_rules", "budgets"].map(table);
  const [transactions, tags, links, budgets, statements] = ["transactions", "transaction_tags", "transaction_links", "budgets", "statements"].map(table);
  return [
    // 1 + the references that were already broken before (none, unless an old version left one): no undo adds to them.
    { sql: `UPDATE history_state SET replaying = 1 + (${BROKEN_REFERENCES}) WHERE id = 1` },
    // Only the newest edit can be undone, only the last undone one redone.
    refuseIf(direction === "undo"
      ? `SELECT (SELECT MAX(id) FROM history_groups WHERE undone_at IS NULL) IS NOT ${group}`
      : `SELECT (SELECT MIN(id) FROM history_groups WHERE undone_at IS NOT NULL) IS NOT ${group}`),
    // Every row is as this edit left it (or already as it should become).
    ...HISTORY_TABLES.map((item) => refuseIf(`SELECT COUNT(*) FROM ${onRow(item)} WHERE ${changes(item)} AND ${current(item)} IS NOT c.${from} AND ${current(item)} IS NOT c.${to}`)),
    // Children leave first.
    remove(links), remove(tags), ...lists.map(remove),
    // Nothing outside this edit may hang on an entry, statement or schedule that is about to leave.
    refuseIf(`SELECT (SELECT COUNT(*) FROM transaction_links WHERE from_transaction_id IN ${gone(transactions)} OR to_transaction_id IN ${gone(transactions)})
      + (SELECT COUNT(*) FROM transaction_tags WHERE transaction_id IN ${gone(transactions)})`),
    ...parents.filter((item) => !item.updatesOnly).map(insert),
    { sql: `UPDATE statements SET import_batch_id = json_extract(c.${to}, '$.import_batch_id') FROM history_changes c WHERE ${changes(statements, ` AND c.${to} IS NOT NULL AND c.${from} IS NULL`)} AND statements.id = json_extract(c.row_key, '$[0]')` },
    ...parents.flatMap((item) => update(item) ?? []),
    insert(transactions), update(transactions)!,
    remove(transactions),
    insert(tags), insert(links), update(links)!, insert(budgets), update(budgets)!,
    refuseIf(`SELECT (SELECT COUNT(*) FROM transactions WHERE statement_id IN ${gone(statements)}) + (SELECT COUNT(*) FROM transactions WHERE recurring_rule_id IN ${gone(table("recurring_rules"))})`),
    ...["statements", "recurring_rules", "tags", "projects", "merchants", "accounts", "settings"].map((name) => remove(table(name))),
    { sql: "UPDATE statements SET transaction_count = (SELECT COUNT(*) FROM transactions WHERE statement_id = statements.id) WHERE source_format = 'manual'" },
    // The result is exactly the other side of the edit, whatever other triggers did meanwhile...
    ...HISTORY_TABLES.map((item) => refuseIf(`SELECT COUNT(*) FROM ${onRow(item)} WHERE ${changes(item)} AND ${current(item)} IS NOT c.${to}${kept(item)}`)),
    // ...no entry, rule or budget names a category this removed, and every reference resolves.
    refuseIf(`SELECT COUNT(*) FROM history_changes c WHERE ${changes(table("custom_categories"), ` AND c.${to} IS NULL`)}
      AND NOT EXISTS (SELECT 1 FROM custom_categories k WHERE k.name = json_extract(c.row_key, '$[0]') COLLATE NOCASE)
      AND (EXISTS (SELECT 1 FROM transactions t WHERE t.category = json_extract(c.row_key, '$[0]') COLLATE NOCASE)
        OR EXISTS (SELECT 1 FROM merchant_rules k WHERE k.category = json_extract(c.row_key, '$[0]') COLLATE NOCASE)
        OR EXISTS (SELECT 1 FROM budgets k WHERE k.category = json_extract(c.row_key, '$[0]') COLLATE NOCASE))`),
    refuseIf(`SELECT (${BROKEN_REFERENCES}) > replaying - 1`),
    { sql: `UPDATE history_groups SET undone_at = ${direction === "undo" ? "?" : "NULL"} WHERE id = ${group}`, params: direction === "undo" ? [stamp] : [] },
    { sql: "UPDATE history_state SET replaying = 0 WHERE id = 1" },
  ];
}

/** SQLite refused because the result would not be valid (a constraint, or one of the book's own guards). */
export const isRefusal = (error: unknown) => /history_conflict|constraint failed|refund_too_large|refund_target_invalid|transfer_leg_missing|import_incomplete|original_description_immutable/i
  .test(String((error as Error)?.message ?? error));

export class History {
  private listeners = new Set<() => void>();

  constructor(private db: SqlDriver, private log: (action: HistoryDirection, entry: HistoryEntry) => SqlStatement) {}

  /** Called after an edit was recorded, undone or redone. Returns how to stop. */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  changed(): void {
    for (const listener of this.listeners) listener();
  }

  async state(): Promise<HistoryState> {
    const select = (which: string) => `SELECT g.id, g.at, g.action, COUNT(c.id) AS entries,
        CASE WHEN COUNT(DISTINCT json_extract(COALESCE(c.after_image, c.before_image), '$.description')) = 1 THEN MAX(json_extract(COALESCE(c.after_image, c.before_image), '$.description')) END AS description
      FROM history_groups g LEFT JOIN history_changes c ON c.group_id = g.id AND c.table_name = 'transactions' WHERE g.id = (${which}) GROUP BY g.id`;
    const [undo, redo] = await this.db.snapshot<Row>([
      { sql: select("SELECT MAX(id) FROM history_groups WHERE undone_at IS NULL") },
      { sql: select("SELECT MIN(id) FROM history_groups WHERE undone_at IS NOT NULL") },
    ]);
    return { undo: toEntry(undo[0]), redo: toEntry(redo[0]) };
  }

  /**
   * Undoes or redoes exactly the edit the person was shown (`id`). "gone": another edit came first, nothing was
   * written. "conflict": it can no longer be reversed exactly; it left the history and nothing else was written.
   */
  async step(direction: HistoryDirection, id: number): Promise<HistoryOutcome> {
    const entry = (await this.state())[direction];
    if (!entry || entry.id !== id) return "gone";
    try {
      await this.db.transaction([...replayStatements(id, direction), this.log(direction, entry)]);
      return "done";
    } catch (error) {
      if (!isRefusal(error)) throw error;
      // Another edit may have been recorded since the entry was shown: that is no conflict with this one.
      if ((await this.state())[direction]?.id !== id) return "gone";
      // What was undone after it builds on it, so it can no longer be redone either.
      const which = direction === "undo" ? "id = ?" : "id >= ? AND undone_at IS NOT NULL";
      await this.db.transaction([
        { sql: `DELETE FROM history_changes WHERE group_id IN (SELECT id FROM history_groups WHERE ${which})`, params: [id] },
        { sql: `DELETE FROM history_groups WHERE ${which}`, params: [id] },
      ]);
      return "conflict";
    } finally {
      this.changed();
    }
  }
}

function toEntry(row: Row | undefined): HistoryEntry | null {
  if (!row) return null;
  return { id: Number(row.id), at: String(row.at), action: String(row.action) as HistoryAction, entries: Number(row.entries), description: row.description === null || row.description === undefined ? null : String(row.description) };
}
