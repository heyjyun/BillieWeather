// What Undo and Redo record (migrations 0010 and 0011, docs/architecture/editing-history.md).
//
// The triggers of migration 0010 and the replay in history.ts build the same JSON image of a row from this
// list; test/history.test.ts fails when a table gains a column that is neither listed nor excluded here, or
// when a trigger and this list disagree. A migration that changes one of these tables must rebuild its
// triggers and empty the history (its images describe the old columns).

export interface HistoryTable {
  name: string;
  /** Primary key. `integer`: an AUTOINCREMENT id, never used twice. */
  key: readonly string[];
  integer: boolean;
  /** Recorded columns, in the order of the image. */
  columns: readonly string[];
  /** Never part of an image: times that replay sets itself, and insert-time helpers that never outlive a statement. */
  excluded: readonly string[];
  /** Only changes of existing rows are recorded (a run's proposals are not part of the book). */
  updatesOnly?: boolean;
  /** Rows the triggers skip, as SQL over `ROW` (replaced by OLD, NEW or the table's alias). */
  only?: string;
  /**
   * Shared rows another entry may use meanwhile (an account an import made, a tag typed with an entry):
   * undoing their creation keeps them while this SQL over `ROW` finds a user.
   */
  usedBy?: string;
}

const named = (name: "merchants" | "projects" | "tags", usedBy: string): HistoryTable => ({
  name, key: ["id"], integer: true, columns: ["id", "uuid", "name", "note", "sort_order", "archived_at", "created_at"], excluded: ["updated_at"], usedBy,
});

/** Parents before children. */
export const HISTORY_TABLES: readonly HistoryTable[] = [
  {
    name: "settings", key: ["key"], integer: false, columns: ["key", "value"], excluded: [], only: "ROW.key IN ('currency', 'month_start_day', 'web_sync_skip')",
    usedBy: "ROW.key = 'currency' AND (EXISTS (SELECT 1 FROM transactions) OR EXISTS (SELECT 1 FROM statements WHERE source_format IS NOT 'manual') OR EXISTS (SELECT 1 FROM accounts))",
  },
  {
    name: "accounts", key: ["id"], integer: true,
    columns: ["id", "uuid", "name", "account_type", "currency", "institution", "last4", "account_key", "opening_balance_cents", "opening_balance_on", "opening_balance_source",
      "credit_limit_cents", "statement_day", "due_day", "include_in_net_worth", "note", "sort_order", "archived_at", "created_at"],
    excluded: ["updated_at"],
    usedBy: `EXISTS (SELECT 1 FROM transactions u WHERE u.account_id = ROW.id) OR EXISTS (SELECT 1 FROM statements u WHERE u.account_id = ROW.id)
      OR EXISTS (SELECT 1 FROM recurring_rules u WHERE json_extract(u.template, '$.accountId') = ROW.id OR json_extract(u.template, '$.toAccountId') = ROW.id)`,
  },
  named("merchants", "EXISTS (SELECT 1 FROM transactions u WHERE u.merchant_id = ROW.id)"),
  named("projects", "EXISTS (SELECT 1 FROM transactions u WHERE u.project_id = ROW.id) OR EXISTS (SELECT 1 FROM budgets u WHERE u.project_id = ROW.id)"),
  named("tags", "EXISTS (SELECT 1 FROM transaction_tags u WHERE u.tag_id = ROW.id)"),
  {
    name: "recurring_rules", key: ["id"], integer: true,
    columns: ["id", "uuid", "name", "template", "frequency", "interval", "start_on", "end_on", "next_on", "auto_post", "paused", "created_at"], excluded: ["updated_at"],
  },
  { name: "custom_categories", key: ["name"], integer: false, columns: ["name", "created_at"], excluded: [] },
  { name: "category_meta", key: ["name"], integer: false, columns: ["name", "parent", "category_kind", "sort_order", "hidden"], excluded: ["updated_at"] },
  // Migration 0011 (the category tree). `expanded` is a view preference, never part of an edit: undo leaves it alone.
  { name: "categories", key: ["name"], integer: false, columns: ["name", "parent", "system_key", "kind", "sort_order", "hidden", "created_at"], excluded: ["expanded", "updated_at"] },
  { name: "merchant_rules", key: ["merchant_key", "income"], integer: false, columns: ["merchant_key", "income", "category"], excluded: ["updated_at"] },
  {
    // The hidden container of manual entries (ledger.ts) is not a statement to people: never recorded, its count is derived.
    name: "statements", key: ["id"], integer: true, only: "ROW.source_format IS NOT 'manual'",
    columns: ["id", "filename", "currency", "sha256", "transaction_count", "closing_balance_cents", "closing_balance_on", "imported_at", "source", "remote_id", "import_batch_id",
      "source_sha256", "source_format", "account_key", "institution", "account_last4", "account_kind", "opening_balance_cents", "opening_balance_on", "import_report", "region",
      "region_source", "detected_region", "region_confidence", "region_evidence", "account_id"],
    excluded: [],
  },
  {
    name: "transactions", key: ["id"], integer: true,
    columns: ["id", "statement_id", "booked_on", "description", "amount_cents", "category", "tax_review", "excluded", "remote_id", "locally_modified", "posted_on", "normalized_merchant",
      "currency", "direction", "balance_cents", "bank_reference", "account_key", "category_source", "pending", "kind_hints", "source_ref", "parse_confidence", "validation_status",
      "source_raw", "uuid", "kind", "account_id", "original_description", "entry_origin", "merchant_id", "project_id", "note", "occurred_at_time", "deleted_at", "user_locked_fields",
      "category_confidence", "category_model", "recurring_rule_id", "recurring_on"],
    excluded: ["updated_at", "link_group", "link_hint", "link_target_id"],
  },
  { name: "transaction_tags", key: ["transaction_id", "tag_id"], integer: false, columns: ["transaction_id", "tag_id"], excluded: [] },
  {
    name: "transaction_links", key: ["id"], integer: true,
    columns: ["id", "uuid", "link_type", "from_transaction_id", "to_transaction_id", "amount_cents", "status", "decided_by", "created_at"], excluded: [],
  },
  { name: "budgets", key: ["id"], integer: true, columns: ["id", "uuid", "period", "category", "project_id", "amount_cents", "alert_percent", "created_at"], excluded: ["updated_at"] },
  { name: "organize_runs", key: ["id"], integer: true, updatesOnly: true, columns: ["id", "status", "applied_at", "undone_at", "batch_id"], excluded: ["uuid", "created_at", "engine", "proposals"] },
];

/** The image of one row as SQLite builds it (exact: integers stay integers, NULL stays null). */
export const imageSql = (table: HistoryTable, row: string) => `json_object(${table.columns.map((column) => `'${column}', ${row}.${column}`).join(", ")})`;

export const keySql = (table: HistoryTable, row: string) => `json_array(${table.key.map((column) => `${row}.${column}`).join(", ")})`;

/** The capture triggers of one table, as migration 0010 creates them. */
export function triggersSql(table: HistoryTable): Record<string, string> {
  const group = "(SELECT group_id FROM history_state WHERE id = 1)";
  const when = (...rows: string[]) => `${group} IS NOT NULL${table.only ? rows.map((row) => ` AND ${table.only!.replaceAll("ROW", row)}`).join("") : ""}`;
  // The first touch of a row in a group fixes what it was before; AFTER INSERT may come after another trigger's
  // UPDATE of the same new row, so it says "absent before" whatever was noted meanwhile.
  const note = (row: string, before: string, extra = "") => `INSERT INTO history_changes (group_id, table_name, row_key, before_image)
    SELECT ${group}, '${table.name}', ${keySql(table, row)}, ${before}
    WHERE NOT EXISTS (SELECT 1 FROM history_changes WHERE group_id = ${group} AND table_name = '${table.name}' AND row_key = ${keySql(table, row)})${extra};`;
  const absent = `UPDATE history_changes SET before_image = NULL WHERE group_id = ${group} AND table_name = '${table.name}' AND row_key = ${keySql(table, "NEW")};`;
  const changedKey = table.key.map((column) => `NEW.${column} IS NOT OLD.${column} COLLATE BINARY`).join(" OR ");
  const trigger = (name: string, event: string, condition: string, body: string[]) =>
    `CREATE TRIGGER history_${table.name}_${name} ${event} ON ${table.name}\nWHEN ${condition}\nBEGIN\n  ${body.join("\n  ")}\nEND;`;
  const update = trigger("update", "BEFORE UPDATE", when("OLD"), [note("OLD", imageSql(table, "OLD")), ...(table.integer ? [] : [note("NEW", "NULL", ` AND (${changedKey})`)])]);
  if (table.updatesOnly) return { update };
  return {
    insert: trigger("insert", "AFTER INSERT", when("NEW"), [...(table.integer ? [absent] : []), note("NEW", "NULL")]),
    update,
    delete: trigger("delete", "BEFORE DELETE", when("OLD"), [note("OLD", imageSql(table, "OLD"))]),
  };
}
