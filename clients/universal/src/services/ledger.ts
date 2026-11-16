// Manual bookkeeping on the device's SQLite database (migration 0007): accounts, manual entries of
// every kind, transfers and refunds with their links, the trash, categories' tree, merchants,
// projects, tags, budgets, recurring entries, reports and the operation log.
//
// Rules (docs/architecture/finance-domain-spec.md):
// - Every write that must be atomic is ONE SQL statement (the Tauri SQL plugin pools connections):
//   a transfer's two legs and its link are one INSERT (trigger transactions_link_pair); a refund and
//   its link are one INSERT (trigger transactions_link_refund).
// - Amounts are signed integer cents from the account's point of view.
// - Deleting is a soft delete into the trash; every change writes an audit event with undo data.
// - Placeholders are `?` (positional in both sql.js and sqlx), never out-of-order `$n`.
import {
  accountClass, adjustmentFor, budgetStatus, categoryKindFor, entryProblems, isAccountType, isLiability, isTransactionKind, netWorth, nextOccurrence,
  occurrences, periodBounds, signedAmount, totals, transferKind, transferLegs, type AccountType, type BudgetPeriod, type BudgetStatus, type CategoryKind,
  type EntryProblem, type Frequency, type LedgerAccount, type LedgerEntry, type TransactionKind, CATEGORY_MAX_DEPTH, FREQUENCIES,
  isBuiltInCategory, normalizeCategoryName,
} from "@billie/finance-core";
import { CATEGORIES } from "@billie/shared-types";
import { randomId } from "./ids";
import type { SqlDriver } from "./store";

type Row = Record<string, unknown>;
const now = () => new Date().toISOString();
const str = (value: unknown): string | null => (value === null || value === undefined ? null : String(value));
const num = (value: unknown): number | null => (value === null || value === undefined ? null : Number(value));
const placeholders = (n: number) => Array.from({ length: n }, () => "?").join(", ");

export const UNASSIGNED_ACCOUNT_KEY = "__unassigned__";
export const MANUAL_CONTAINER_SHA = "manual-entries:v1";
export const NAME_MAX = 60;

export type LedgerErrorCode =
  | "not_found" | "invalid_name" | "name_taken" | "account_in_use" | "invalid_account_type" | "invalid_entry" | "refund_too_large" | "category_depth"
  | "category_cycle" | "invalid_budget" | "invalid_schedule" | "currency_unknown" | "not_in_trash";

export class LedgerError extends Error {
  constructor(public code: LedgerErrorCode, message: string, public problems: EntryProblem[] = []) {
    super(message);
    this.name = "LedgerError";
  }
}

export interface Account {
  id: number;
  uuid: string;
  name: string;
  type: AccountType;
  accountClass: "asset" | "liability";
  currency: string;
  institution: string | null;
  last4: string | null;
  accountKey: string | null;
  openingBalanceCents: number;
  openingBalanceOn: string | null;
  openingBalanceSource: "user" | "statement" | "unknown";
  creditLimitCents: number | null;
  statementDay: number | null;
  dueDay: number | null;
  includeInNetWorth: boolean;
  note: string | null;
  sortOrder: number;
  archived: boolean;
  /** Opening balance plus every live entry (transfers and adjustments included). */
  balanceCents: number;
  entryCount: number;
  /** True for the account holding imported rows whose account was never known. */
  unassigned: boolean;
}

export interface AccountInput {
  name: string;
  type: AccountType;
  currency?: string;
  institution?: string | null;
  last4?: string | null;
  openingBalanceCents?: number;
  openingBalanceOn?: string | null;
  creditLimitCents?: number | null;
  statementDay?: number | null;
  dueDay?: number | null;
  includeInNetWorth?: boolean;
  note?: string | null;
}

export interface EntryInput {
  kind: TransactionKind;
  /** The amount as typed: positive. For `adjustment`, the signed change (use `adjustBalance` for a target balance). */
  amountCents: number;
  occurredOn: string;
  time?: string | null;
  accountId: number;
  /** Destination account of a transfer / card payment. */
  toAccountId?: number | null;
  category?: string | null;
  description?: string | null;
  note?: string | null;
  merchant?: string | null;
  project?: string | null;
  tags?: string[];
  /** The original expense a refund belongs to (required for kind = refund created by hand, optional otherwise). */
  refundOf?: number | null;
}

export interface EntryDetail {
  id: number;
  uuid: string;
  kind: TransactionKind;
  accountId: number;
  accountName: string;
  amountCents: number;
  occurredOn: string;
  time: string | null;
  category: string;
  description: string;
  originalDescription: string;
  note: string | null;
  merchant: string | null;
  project: string | null;
  tags: string[];
  origin: string;
  excluded: boolean;
  deletedAt: string | null;
  lockedFields: string[];
  categorySource: string;
  /** For a transfer / card payment: the other leg. */
  counterpart: { id: number; accountId: number; accountName: string; amountCents: number } | null;
  /** For a refund: the expense it refunds. */
  refundOf: { id: number; description: string; amountCents: number } | null;
  /** For an expense: refunds linked to it and what is still refundable. */
  refunds: Array<{ id: number; amountCents: number; occurredOn: string }>;
  refundableCents: number;
}

export interface CategoryNode {
  name: string;
  builtIn: boolean;
  kind: CategoryKind | "transfer" | "any";
  parent: string | null;
  hidden: boolean;
  sortOrder: number;
  children: CategoryNode[];
}

export interface Dimension {
  id: number;
  uuid: string;
  name: string;
  note: string | null;
  archived: boolean;
  sortOrder: number;
  entryCount: number;
}
export type DimensionKind = "merchant" | "project" | "tag";
const DIMENSION_TABLE: Record<DimensionKind, string> = { merchant: "merchants", project: "projects", tag: "tags" };

export interface Budget {
  id: number;
  uuid: string;
  period: BudgetPeriod;
  category: string | null;
  projectId: number | null;
  projectName: string | null;
  amountCents: number;
  alertPercent: number;
  from: string;
  to: string;
  status: BudgetStatus;
}

export interface RecurringTemplate {
  kind: TransactionKind;
  amountCents: number;
  accountId: number;
  toAccountId?: number | null;
  category?: string | null;
  description?: string | null;
  note?: string | null;
  merchant?: string | null;
  project?: string | null;
  tags?: string[];
}

export interface RecurringRule {
  id: number;
  uuid: string;
  name: string;
  template: RecurringTemplate;
  frequency: Frequency;
  interval: number;
  startOn: string;
  endOn: string | null;
  nextOn: string | null;
  autoPost: boolean;
  paused: boolean;
}

export interface AuditEvent {
  id: number;
  uuid: string;
  at: string;
  actor: string;
  action: string;
  subjectType: string;
  subjectId: string | null;
  batchId: string | null;
  summary: string | null;
  changes: Record<string, [unknown, unknown]> | null;
  undoable: boolean;
}

/** Instructions stored with an audit event to reverse it. */
export type UndoStep =
  | { op: "set"; table: "transactions"; id: number; fields: Record<string, unknown> }
  | { op: "soft_delete"; ids: number[] }
  | { op: "restore"; ids: number[] }
  | { op: "delete_link"; id: number }
  | { op: "insert_link"; link: { link_type: string; from_transaction_id: number; to_transaction_id: number | null; amount_cents: number | null; status: string; decided_by: string } };

const ENTRY_SELECT = `SELECT t.*, a.name AS account_name, m.name AS merchant_name, p.name AS project_name,
  (SELECT group_concat(g.name, char(31)) FROM transaction_tags tt JOIN tags g ON g.id = tt.tag_id WHERE tt.transaction_id = t.id) AS tag_names
  FROM transactions t LEFT JOIN accounts a ON a.id = t.account_id LEFT JOIN merchants m ON m.id = t.merchant_id LEFT JOIN projects p ON p.id = t.project_id`;

const parseLocked = (value: unknown): string[] => {
  try {
    const parsed = JSON.parse(String(value ?? "[]")) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
};

const toAccount = (row: Row): Account => {
  const type = (isAccountType(row.account_type) ? row.account_type : "other") as AccountType;
  return {
    id: Number(row.id), uuid: String(row.uuid), name: String(row.name), type, accountClass: accountClass(type), currency: String(row.currency),
    institution: str(row.institution), last4: str(row.last4), accountKey: str(row.account_key), openingBalanceCents: Number(row.opening_balance_cents ?? 0),
    openingBalanceOn: str(row.opening_balance_on), openingBalanceSource: (str(row.opening_balance_source) ?? "user") as Account["openingBalanceSource"],
    creditLimitCents: num(row.credit_limit_cents), statementDay: num(row.statement_day), dueDay: num(row.due_day),
    includeInNetWorth: Number(row.include_in_net_worth ?? 1) === 1, note: str(row.note), sortOrder: Number(row.sort_order ?? 0), archived: row.archived_at !== null && row.archived_at !== undefined,
    balanceCents: Number(row.opening_balance_cents ?? 0) + Number(row.movement ?? 0), entryCount: Number(row.entry_count ?? 0), unassigned: row.account_key === UNASSIGNED_ACCOUNT_KEY,
  };
};

const cleanName = (name: string, max = NAME_MAX) => [...normalizeCategoryName(name)].slice(0, max).join("").trim();

export class LedgerStore {
  constructor(private db: SqlDriver) {}

  // ---------------------------------------------------------------------------------------- audit

  /** Appends one operation-log event. Values stay on this device (decision Q10). */
  async audit(event: { actor?: string; action: string; subjectType: string; subjectId?: string | number | null; batchId?: string | null; summary?: string | null; changes?: Record<string, [unknown, unknown]> | null; undo?: UndoStep[] | null }): Promise<void> {
    await this.db.execute(
      "INSERT INTO audit_events (uuid, at, actor, action, subject_type, subject_id, batch_id, summary, changes, undo) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [randomId(), now(), event.actor ?? "user", event.action, event.subjectType, event.subjectId === undefined || event.subjectId === null ? null : String(event.subjectId),
        event.batchId ?? null, event.summary ?? null, event.changes ? JSON.stringify(event.changes) : null, event.undo && event.undo.length > 0 ? JSON.stringify(event.undo) : null],
    );
  }

  async auditEvents(options: { limit?: number; subjectType?: string; subjectId?: string | number; batchId?: string; actor?: string } = {}): Promise<AuditEvent[]> {
    const where: string[] = [];
    const params: unknown[] = [];
    if (options.subjectType) { where.push("subject_type = ?"); params.push(options.subjectType); }
    if (options.subjectId !== undefined) { where.push("subject_id = ?"); params.push(String(options.subjectId)); }
    if (options.batchId) { where.push("batch_id = ?"); params.push(options.batchId); }
    if (options.actor) { where.push("actor = ?"); params.push(options.actor); }
    params.push(Math.min(Math.max(1, options.limit ?? 200), 2000));
    const rows = await this.db.select<Row>(`SELECT * FROM audit_events ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY id DESC LIMIT ?`, params);
    return rows.map((row) => ({
      id: Number(row.id), uuid: String(row.uuid), at: String(row.at), actor: String(row.actor), action: String(row.action), subjectType: String(row.subject_type),
      subjectId: str(row.subject_id), batchId: str(row.batch_id), summary: str(row.summary),
      changes: row.changes ? (JSON.parse(String(row.changes)) as AuditEvent["changes"]) : null, undoable: row.undo !== null && row.undo !== undefined,
    }));
  }

  /** Reverses every event of one batch (newest first), e.g. an "Organize with AI" run. Returns how many steps ran. */
  async undoBatch(batchId: string, actor = "user"): Promise<number> {
    const rows = await this.db.select<Row>("SELECT id, undo FROM audit_events WHERE batch_id = ? AND undo IS NOT NULL ORDER BY id DESC", [batchId]);
    let steps = 0;
    for (const row of rows) {
      for (const step of JSON.parse(String(row.undo)) as UndoStep[]) {
        await this.runUndo(step);
        steps += 1;
      }
    }
    if (steps > 0) await this.audit({ actor, action: "ai_undo", subjectType: "batch", subjectId: batchId, summary: `${steps} change(s) reversed` });
    return steps;
  }

  private async runUndo(step: UndoStep): Promise<void> {
    switch (step.op) {
      case "set": {
        const allowed = ["category", "category_source", "category_confidence", "category_model", "kind", "description", "excluded", "merchant_id", "project_id", "user_locked_fields", "locally_modified", "tax_review", "note", "account_id"];
        const fields = Object.entries(step.fields).filter(([key]) => allowed.includes(key));
        if (fields.length === 0) return;
        await this.db.execute(`UPDATE transactions SET ${fields.map(([key]) => `${key} = ?`).join(", ")}, updated_at = ? WHERE id = ?`, [...fields.map(([, value]) => value), now(), step.id]);
        return;
      }
      case "soft_delete":
        if (step.ids.length) await this.db.execute(`UPDATE transactions SET deleted_at = ?, updated_at = ? WHERE id IN (${placeholders(step.ids.length)})`, [now(), now(), ...step.ids]);
        return;
      case "restore":
        if (step.ids.length) await this.db.execute(`UPDATE transactions SET deleted_at = NULL, updated_at = ? WHERE id IN (${placeholders(step.ids.length)})`, [now(), ...step.ids]);
        return;
      case "delete_link":
        await this.db.execute("DELETE FROM transaction_links WHERE id = ?", [step.id]);
        return;
      case "insert_link":
        await this.db.execute(
          "INSERT OR IGNORE INTO transaction_links (uuid, link_type, from_transaction_id, to_transaction_id, amount_cents, status, decided_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
          [randomId(), step.link.link_type, step.link.from_transaction_id, step.link.to_transaction_id, step.link.amount_cents, step.link.status, step.link.decided_by, now()],
        );
    }
  }

  // ------------------------------------------------------------------------------------ settings

  async setting(key: string): Promise<string | null> {
    const [row] = await this.db.select<Row>("SELECT value FROM settings WHERE key = ?", [key]);
    return row ? String(row.value) : null;
  }

  private async setSetting(key: string, value: string): Promise<void> {
    await this.db.execute("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value", [key, value]);
  }

  /** The book's currency: the one imports fixed, else the one chosen for manual bookkeeping. */
  async bookCurrency(): Promise<string | null> {
    return this.setting("currency");
  }

  async setBookCurrency(currency: string): Promise<void> {
    const existing = await this.bookCurrency();
    if (existing && existing !== currency) throw new LedgerError("currency_unknown", "This book already has a currency.");
    await this.setSetting("currency", currency);
  }

  /** Day a "month" starts on for budgets and reports (1–28), like Suishouji's custom month start. */
  async monthStartDay(): Promise<number> {
    const value = Number(await this.setting("month_start_day"));
    return Number.isInteger(value) && value >= 1 && value <= 28 ? value : 1;
  }

  async setMonthStartDay(day: number): Promise<void> {
    if (!Number.isInteger(day) || day < 1 || day > 28) throw new LedgerError("invalid_budget", "Choose a day from 1 to 28.");
    await this.setSetting("month_start_day", String(day));
  }

  // ------------------------------------------------------------------------------------ accounts

  async accounts(options: { includeArchived?: boolean } = {}): Promise<Account[]> {
    const rows = await this.db.select<Row>(`SELECT a.*,
        (SELECT COALESCE(SUM(t.amount_cents), 0) FROM transactions t WHERE t.account_id = a.id AND t.deleted_at IS NULL) AS movement,
        (SELECT COUNT(*) FROM transactions t WHERE t.account_id = a.id AND t.deleted_at IS NULL) AS entry_count
      FROM accounts a ${options.includeArchived ? "" : "WHERE a.archived_at IS NULL"} ORDER BY a.archived_at IS NOT NULL, a.sort_order, a.id`);
    return rows.map(toAccount);
  }

  async account(id: number): Promise<Account> {
    const found = (await this.accounts({ includeArchived: true })).find((account) => account.id === id);
    if (!found) throw new LedgerError("not_found", "Account not found.");
    return found;
  }

  async createAccount(input: AccountInput, actor = "user"): Promise<Account> {
    const name = cleanName(input.name);
    if (!name) throw new LedgerError("invalid_name", "Give the account a name.");
    if (!isAccountType(input.type)) throw new LedgerError("invalid_account_type", "Unknown account type.");
    const currency = input.currency ?? (await this.bookCurrency());
    if (!currency) throw new LedgerError("currency_unknown", "Choose this book's currency first.");
    await this.checkAccountName(name);
    const [{ next }] = await this.db.select<Row>("SELECT COALESCE(MAX(sort_order), 0) + 1 AS next FROM accounts");
    const stamp = now();
    const uuid = randomId();
    await this.db.execute(
      `INSERT INTO accounts (uuid, name, account_type, currency, institution, last4, opening_balance_cents, opening_balance_on, opening_balance_source, credit_limit_cents,
        statement_day, due_day, include_in_net_worth, note, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'user', ?, ?, ?, ?, ?, ?, ?, ?)`,
      [uuid, name, input.type, currency, input.institution?.trim() || null, input.last4?.trim() || null, Math.trunc(input.openingBalanceCents ?? 0), input.openingBalanceOn ?? null,
        input.creditLimitCents ?? null, input.statementDay ?? null, input.dueDay ?? null, input.includeInNetWorth === false ? 0 : 1, input.note?.trim() || null, Number(next), stamp, stamp],
    );
    if (!(await this.bookCurrency())) await this.setSetting("currency", currency);
    const [row] = await this.db.select<Row>("SELECT id FROM accounts WHERE uuid = ?", [uuid]);
    await this.audit({ actor, action: "create", subjectType: "account", subjectId: uuid, summary: name, changes: { name: [null, name], type: [null, input.type], openingBalanceCents: [null, input.openingBalanceCents ?? 0] } });
    return this.account(Number(row.id));
  }

  private async checkAccountName(name: string, except?: number): Promise<void> {
    const rows = await this.db.select<Row>("SELECT id FROM accounts WHERE lower(name) = lower(?) AND archived_at IS NULL", [name]);
    if (rows.some((row) => Number(row.id) !== except)) throw new LedgerError("name_taken", "Another account has this name.");
  }

  async updateAccount(id: number, patch: Partial<AccountInput>, actor = "user"): Promise<Account> {
    const before = await this.account(id);
    const fields: Record<string, unknown> = {};
    if (patch.name !== undefined) {
      const name = cleanName(patch.name);
      if (!name) throw new LedgerError("invalid_name", "Give the account a name.");
      await this.checkAccountName(name, id);
      fields.name = name;
    }
    if (patch.type !== undefined) {
      if (!isAccountType(patch.type)) throw new LedgerError("invalid_account_type", "Unknown account type.");
      fields.account_type = patch.type;
    }
    if (patch.institution !== undefined) fields.institution = patch.institution?.trim() || null;
    if (patch.last4 !== undefined) fields.last4 = patch.last4?.trim() || null;
    if (patch.openingBalanceCents !== undefined) { fields.opening_balance_cents = Math.trunc(patch.openingBalanceCents); fields.opening_balance_source = "user"; }
    if (patch.openingBalanceOn !== undefined) fields.opening_balance_on = patch.openingBalanceOn;
    if (patch.creditLimitCents !== undefined) fields.credit_limit_cents = patch.creditLimitCents;
    if (patch.statementDay !== undefined) fields.statement_day = patch.statementDay;
    if (patch.dueDay !== undefined) fields.due_day = patch.dueDay;
    if (patch.includeInNetWorth !== undefined) fields.include_in_net_worth = patch.includeInNetWorth ? 1 : 0;
    if (patch.note !== undefined) fields.note = patch.note?.trim() || null;
    const entries = Object.entries(fields);
    if (entries.length === 0) return before;
    await this.db.execute(`UPDATE accounts SET ${entries.map(([key]) => `${key} = ?`).join(", ")}, updated_at = ? WHERE id = ?`, [...entries.map(([, value]) => value), now(), id]);
    const after = await this.account(id);
    const changes: Record<string, [unknown, unknown]> = {};
    for (const key of Object.keys(patch) as Array<keyof AccountInput>) {
      const was = (before as unknown as Record<string, unknown>)[key === "type" ? "type" : key];
      const is = (after as unknown as Record<string, unknown>)[key === "type" ? "type" : key];
      if (was !== is) changes[key] = [was, is];
    }
    await this.audit({ actor, action: "update", subjectType: "account", subjectId: before.uuid, summary: after.name, changes });
    return after;
  }

  async setAccountArchived(id: number, archived: boolean, actor = "user"): Promise<void> {
    const account = await this.account(id);
    await this.db.execute("UPDATE accounts SET archived_at = ?, updated_at = ? WHERE id = ?", [archived ? now() : null, now(), id]);
    await this.audit({ actor, action: archived ? "archive" : "unarchive", subjectType: "account", subjectId: account.uuid, summary: account.name });
  }

  /** Deletes an account that has never been used. Accounts with entries (even in the trash) or statements are archived instead. */
  async deleteAccount(id: number, actor = "user"): Promise<void> {
    const account = await this.account(id);
    const [usage] = await this.db.select<Row>("SELECT (SELECT COUNT(*) FROM transactions WHERE account_id = ?) AS entries, (SELECT COUNT(*) FROM statements WHERE account_id = ?) AS statements",
      [id, id]);
    if (Number(usage.entries) > 0 || Number(usage.statements) > 0) throw new LedgerError("account_in_use", "This account has entries; archive it instead.");
    await this.db.execute("DELETE FROM accounts WHERE id = ?", [id]);
    await this.audit({ actor, action: "delete", subjectType: "account", subjectId: account.uuid, summary: account.name });
  }

  async reorderAccounts(ids: readonly number[]): Promise<void> {
    for (const [index, id] of ids.entries()) await this.db.execute("UPDATE accounts SET sort_order = ?, updated_at = ? WHERE id = ?", [index + 1, now(), id]);
  }

  /** Records a balance check (余额): one adjustment entry so the computed balance equals what the person sees. Returns the entry id, or null when nothing changes. */
  async adjustBalance(accountId: number, targetCents: number, occurredOn: string, note: string | null = null, actor = "user"): Promise<number | null> {
    const account = await this.account(accountId);
    const delta = adjustmentFor(account.balanceCents, Math.trunc(targetCents));
    if (delta === 0) return null;
    const [id] = await this.createEntry({ kind: "adjustment", amountCents: delta, occurredOn, accountId, category: "Transfers", description: "Balance adjustment", note }, actor);
    return id;
  }

  /** The account holding imported rows whose account was never known (created on demand). */
  async unassignedAccountId(currency: string): Promise<number> {
    const [row] = await this.db.select<Row>("SELECT id FROM accounts WHERE account_key = ?", [UNASSIGNED_ACCOUNT_KEY]);
    if (row) return Number(row.id);
    const stamp = now();
    await this.db.execute(
      "INSERT INTO accounts (uuid, name, account_type, currency, account_key, opening_balance_source, sort_order, created_at, updated_at) VALUES (?, 'Imported (no account)', 'other', ?, ?, 'unknown', 999, ?, ?)",
      [randomId(), currency, UNASSIGNED_ACCOUNT_KEY, stamp, stamp],
    );
    return this.unassignedAccountId(currency);
  }

  /** The account for an imported statement's account key, created on first import. */
  async accountForImport(info: { key: string | null; institution?: string | null; last4?: string | null; kind?: string | null; currency: string }): Promise<number> {
    if (!info.key) return this.unassignedAccountId(info.currency);
    const [row] = await this.db.select<Row>("SELECT id FROM accounts WHERE account_key = ?", [info.key]);
    if (row) return Number(row.id);
    const type: AccountType = info.kind === "checking" || info.kind === "savings" || info.kind === "credit_card" || info.kind === "loan" ? info.kind : "other";
    const base = cleanName(`${info.institution ?? ""}${info.last4 ? ` …${info.last4}` : ""}`) || "Account";
    let name = base;
    for (let n = 2; (await this.db.select<Row>("SELECT 1 FROM accounts WHERE lower(name) = lower(?)", [name])).length > 0; n += 1) name = cleanName(`${base} (${n})`);
    const stamp = now();
    const uuid = randomId();
    await this.db.execute(
      "INSERT INTO accounts (uuid, name, account_type, currency, institution, last4, account_key, opening_balance_source, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'unknown', ?, ?)",
      [uuid, name, type, info.currency, info.institution ?? null, info.last4 ?? null, info.key, stamp, stamp],
    );
    await this.audit({ actor: "import", action: "create", subjectType: "account", subjectId: uuid, summary: name });
    const [created] = await this.db.select<Row>("SELECT id FROM accounts WHERE uuid = ?", [uuid]);
    return Number(created.id);
  }

  // ------------------------------------------------------------------------------ dimensions

  async dimensions(kind: DimensionKind, options: { includeArchived?: boolean } = {}): Promise<Dimension[]> {
    const table = DIMENSION_TABLE[kind];
    const usage = kind === "tag"
      ? "(SELECT COUNT(*) FROM transaction_tags tt JOIN transactions t ON t.id = tt.transaction_id WHERE tt.tag_id = d.id AND t.deleted_at IS NULL)"
      : `(SELECT COUNT(*) FROM transactions t WHERE t.${kind}_id = d.id AND t.deleted_at IS NULL)`;
    const rows = await this.db.select<Row>(`SELECT d.*, ${usage} AS entry_count FROM ${table} d ${options.includeArchived ? "" : "WHERE d.archived_at IS NULL"} ORDER BY d.archived_at IS NOT NULL, d.sort_order, d.name COLLATE NOCASE`);
    return rows.map((row) => ({ id: Number(row.id), uuid: String(row.uuid), name: String(row.name), note: str(row.note), archived: row.archived_at !== null, sortOrder: Number(row.sort_order), entryCount: Number(row.entry_count) }));
  }

  /** Finds a dimension by name (any letter case) or creates it. Null for an empty name. */
  async dimensionId(kind: DimensionKind, name: string | null | undefined, actor = "user"): Promise<number | null> {
    const clean = cleanName(name ?? "", kind === "tag" ? 40 : NAME_MAX);
    if (!clean) return null;
    const table = DIMENSION_TABLE[kind];
    const [row] = await this.db.select<Row>(`SELECT id, archived_at FROM ${table} WHERE name = ? COLLATE NOCASE`, [clean]);
    if (row) {
      if (row.archived_at !== null) await this.db.execute(`UPDATE ${table} SET archived_at = NULL, updated_at = ? WHERE id = ?`, [now(), Number(row.id)]);
      return Number(row.id);
    }
    const stamp = now();
    const uuid = randomId();
    await this.db.execute(`INSERT INTO ${table} (uuid, name, created_at, updated_at) VALUES (?, ?, ?, ?)`, [uuid, clean, stamp, stamp]);
    await this.audit({ actor, action: "create", subjectType: kind, subjectId: uuid, summary: clean });
    const [created] = await this.db.select<Row>(`SELECT id FROM ${table} WHERE uuid = ?`, [uuid]);
    return Number(created.id);
  }

  async createDimension(kind: DimensionKind, name: string, note: string | null = null): Promise<Dimension> {
    const clean = cleanName(name, kind === "tag" ? 40 : NAME_MAX);
    if (!clean) throw new LedgerError("invalid_name", "Give it a name.");
    const table = DIMENSION_TABLE[kind];
    if ((await this.db.select<Row>(`SELECT 1 FROM ${table} WHERE name = ? COLLATE NOCASE`, [clean])).length > 0) throw new LedgerError("name_taken", "That name is already used.");
    const id = await this.dimensionId(kind, clean);
    if (note) await this.db.execute(`UPDATE ${table} SET note = ? WHERE id = ?`, [note.trim().slice(0, 500), id]);
    return (await this.dimensions(kind, { includeArchived: true })).find((item) => item.id === id)!;
  }

  async renameDimension(kind: DimensionKind, id: number, name: string, actor = "user"): Promise<void> {
    const clean = cleanName(name, kind === "tag" ? 40 : NAME_MAX);
    if (!clean) throw new LedgerError("invalid_name", "Give it a name.");
    const table = DIMENSION_TABLE[kind];
    const [current] = await this.db.select<Row>(`SELECT uuid, name FROM ${table} WHERE id = ?`, [id]);
    if (!current) throw new LedgerError("not_found", "Not found.");
    const clash = await this.db.select<Row>(`SELECT id FROM ${table} WHERE name = ? COLLATE NOCASE AND id <> ?`, [clean, id]);
    if (clash.length > 0) throw new LedgerError("name_taken", "That name is already used.");
    await this.db.execute(`UPDATE ${table} SET name = ?, updated_at = ? WHERE id = ?`, [clean, now(), id]);
    await this.audit({ actor, action: "update", subjectType: kind, subjectId: String(current.uuid), changes: { name: [current.name, clean] } });
  }

  async setDimensionArchived(kind: DimensionKind, id: number, archived: boolean, actor = "user"): Promise<void> {
    const table = DIMENSION_TABLE[kind];
    const [current] = await this.db.select<Row>(`SELECT uuid, name FROM ${table} WHERE id = ?`, [id]);
    if (!current) throw new LedgerError("not_found", "Not found.");
    await this.db.execute(`UPDATE ${table} SET archived_at = ?, updated_at = ? WHERE id = ?`, [archived ? now() : null, now(), id]);
    await this.audit({ actor, action: archived ? "archive" : "unarchive", subjectType: kind, subjectId: String(current.uuid), summary: String(current.name) });
  }

  /** Moves every entry from one merchant/project/tag to another and removes the first. */
  async mergeDimension(kind: DimensionKind, fromId: number, intoId: number, actor = "user"): Promise<number> {
    if (fromId === intoId) return 0;
    const table = DIMENSION_TABLE[kind];
    const [from] = await this.db.select<Row>(`SELECT uuid, name FROM ${table} WHERE id = ?`, [fromId]);
    const [into] = await this.db.select<Row>(`SELECT uuid, name FROM ${table} WHERE id = ?`, [intoId]);
    if (!from || !into) throw new LedgerError("not_found", "Not found.");
    let moved: number;
    if (kind === "tag") {
      await this.db.execute("INSERT OR IGNORE INTO transaction_tags (transaction_id, tag_id) SELECT transaction_id, ? FROM transaction_tags WHERE tag_id = ?", [intoId, fromId]);
      moved = (await this.db.execute("DELETE FROM transaction_tags WHERE tag_id = ?", [fromId])).rowsAffected;
    } else {
      moved = (await this.db.execute(`UPDATE transactions SET ${kind}_id = ?, updated_at = ? WHERE ${kind}_id = ?`, [intoId, now(), fromId])).rowsAffected;
      if (kind === "project") await this.db.execute("UPDATE budgets SET project_id = ? WHERE project_id = ? AND NOT EXISTS (SELECT 1 FROM budgets b WHERE b.project_id = ? AND b.period = budgets.period)", [intoId, fromId, intoId]);
    }
    await this.db.execute(`DELETE FROM ${table} WHERE id = ?`, [fromId]);
    await this.audit({ actor, action: "merge", subjectType: kind, subjectId: String(into.uuid), summary: `${from.name} → ${into.name}`, changes: { moved: [moved, null] } });
    return moved;
  }

  /** Deletes a merchant/project/tag. Entries keep everything else; the dimension is cleared on them. */
  async deleteDimension(kind: DimensionKind, id: number, actor = "user"): Promise<number> {
    const table = DIMENSION_TABLE[kind];
    const [current] = await this.db.select<Row>(`SELECT uuid, name FROM ${table} WHERE id = ?`, [id]);
    if (!current) throw new LedgerError("not_found", "Not found.");
    let cleared: number;
    if (kind === "tag") cleared = (await this.db.execute("DELETE FROM transaction_tags WHERE tag_id = ?", [id])).rowsAffected;
    else {
      const ids = (await this.db.select<Row>(`SELECT id FROM transactions WHERE ${kind}_id = ?`, [id])).map((row) => Number(row.id));
      cleared = ids.length;
      await this.db.execute(`UPDATE transactions SET ${kind}_id = NULL, updated_at = ? WHERE ${kind}_id = ?`, [now(), id]);
      if (kind === "project") await this.db.execute("DELETE FROM budgets WHERE project_id = ?", [id]);
    }
    await this.db.execute(`DELETE FROM ${table} WHERE id = ?`, [id]);
    await this.audit({ actor, action: "delete", subjectType: kind, subjectId: String(current.uuid), summary: String(current.name), changes: { entries: [cleared, 0] } });
    return cleared;
  }

  // ------------------------------------------------------------------------------- categories

  /** The two-level category tree: built-ins and custom categories with their settings. */
  async categoryTree(customCategories: readonly string[]): Promise<CategoryNode[]> {
    const meta = new Map((await this.db.select<Row>("SELECT * FROM category_meta")).map((row) => [String(row.name).toLowerCase(), row]));
    const nodes = new Map<string, CategoryNode>();
    const builtInKind = (name: string): CategoryNode["kind"] => (name === "Income" ? "income" : name === "Transfers" ? "transfer" : name === "Uncategorized" ? "any" : "expense");
    [...CATEGORIES, ...customCategories.filter((name) => !isBuiltInCategory(name))].forEach((name, index) => {
      const row = meta.get(name.toLowerCase());
      const builtIn = isBuiltInCategory(name);
      nodes.set(name.toLowerCase(), {
        name, builtIn, kind: builtIn ? builtInKind(name) : ((str(row?.category_kind) ?? "expense") as CategoryKind),
        parent: builtIn ? null : str(row?.parent), hidden: Number(row?.hidden ?? 0) === 1, sortOrder: row ? Number(row.sort_order) : 1000 + index, children: [],
      });
    });
    const roots: CategoryNode[] = [];
    for (const node of nodes.values()) {
      const parent = node.parent ? nodes.get(node.parent.toLowerCase()) : undefined;
      if (parent && !parent.parent && parent !== node) {
        node.parent = parent.name;
        // A child inherits its parent's tree (income or expense).
        if (parent.kind === "income" || parent.kind === "expense") node.kind = parent.kind;
        parent.children.push(node);
      } else {
        node.parent = null;
        roots.push(node);
      }
    }
    const order = (a: CategoryNode, b: CategoryNode) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name);
    for (const node of nodes.values()) node.children.sort(order);
    return roots.sort(order);
  }

  /** Names in the income tree (custom categories whose kind or parent's kind is income). */
  async incomeCategories(customCategories: readonly string[]): Promise<Set<string>> {
    const names = new Set<string>();
    const walk = (nodes: CategoryNode[]) => nodes.forEach((node) => { if (node.kind === "income" && node.name !== "Income") names.add(node.name); walk(node.children); });
    walk(await this.categoryTree(customCategories));
    return names;
  }

  /** Sets a category's parent (two levels at most), tree (custom only) or hidden flag. */
  async setCategoryMeta(name: string, patch: { parent?: string | null; kind?: CategoryKind; hidden?: boolean }, customCategories: readonly string[], actor = "user"): Promise<void> {
    const tree = await this.categoryTree(customCategories);
    const flat = tree.flatMap((node) => [node, ...node.children]);
    const node = flat.find((item) => item.name.toLowerCase() === name.toLowerCase());
    if (!node) throw new LedgerError("not_found", "Category not found.");
    const [existing] = await this.db.select<Row>("SELECT * FROM category_meta WHERE name = ?", [node.name]);
    let parent = existing ? str(existing.parent) : null;
    let kind = existing ? String(existing.category_kind) : node.kind === "income" ? "income" : "expense";
    if (patch.parent !== undefined) {
      if (node.builtIn && patch.parent) throw new LedgerError("category_depth", "Built-in categories stay at the top level.");
      if (patch.parent) {
        const target = flat.find((item) => item.name.toLowerCase() === patch.parent!.toLowerCase());
        if (!target) throw new LedgerError("not_found", "Parent category not found.");
        if (target.name.toLowerCase() === node.name.toLowerCase()) throw new LedgerError("category_cycle", "A category cannot contain itself.");
        if (target.parent || node.children.length > 0 || CATEGORY_MAX_DEPTH < 2) throw new LedgerError("category_depth", "Categories have two levels at most.");
        if (target.kind === "transfer" || target.name === "Uncategorized") throw new LedgerError("category_depth", "That category cannot have subcategories.");
        parent = target.name;
        if (target.kind === "income" || target.kind === "expense") kind = target.kind;
      } else parent = null;
    }
    if (patch.kind !== undefined && !node.builtIn) kind = patch.kind;
    const hidden = patch.hidden !== undefined ? (patch.hidden ? 1 : 0) : Number(existing?.hidden ?? 0);
    await this.db.execute(
      `INSERT INTO category_meta (name, parent, category_kind, sort_order, hidden, updated_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (name) DO UPDATE SET parent = excluded.parent, category_kind = excluded.category_kind, hidden = excluded.hidden, updated_at = excluded.updated_at`,
      [node.name, parent, kind, existing ? Number(existing.sort_order) : node.sortOrder, hidden, now()],
    );
    // Children follow their parent's tree.
    if (patch.kind !== undefined) await this.db.execute("UPDATE category_meta SET category_kind = ?, updated_at = ? WHERE parent = ?", [kind, now(), node.name]);
    await this.audit({ actor, action: "update", subjectType: "category", subjectId: node.name, changes: Object.fromEntries(Object.entries(patch).map(([key, value]) => [key, [null, value]])) });
  }

  async reorderCategories(names: readonly string[]): Promise<void> {
    for (const [index, name] of names.entries()) {
      await this.db.execute(
        `INSERT INTO category_meta (name, category_kind, sort_order, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT (name) DO UPDATE SET sort_order = excluded.sort_order, updated_at = excluded.updated_at`,
        [name, name === "Income" ? "income" : "expense", index + 1, now()],
      );
    }
  }

  /** Keeps category settings in step when a custom category is renamed (called by FinanceStore). */
  async renameCategoryMeta(from: string, to: string): Promise<void> {
    await this.db.execute("UPDATE category_meta SET name = ?, updated_at = ? WHERE name = ?", [to, now(), from]);
    await this.db.execute("UPDATE category_meta SET parent = ?, updated_at = ? WHERE parent = ?", [to, now(), from]);
    await this.db.execute("UPDATE budgets SET category = ?, updated_at = ? WHERE category = ?", [to, now(), from]);
  }

  /** Removes a deleted category's settings; its children move to the top level. */
  async deleteCategoryMeta(name: string): Promise<void> {
    await this.db.execute("UPDATE category_meta SET parent = NULL, updated_at = ? WHERE parent = ?", [now(), name]);
    await this.db.execute("DELETE FROM category_meta WHERE name = ?", [name]);
    await this.db.execute("DELETE FROM budgets WHERE category = ?", [name]);
  }

  // ---------------------------------------------------------------------------------- entries

  private async manualContainerId(currency: string): Promise<number> {
    const [row] = await this.db.select<Row>("SELECT id FROM statements WHERE sha256 = ?", [MANUAL_CONTAINER_SHA]);
    if (row) return Number(row.id);
    // One hidden statement row per book holds manual entries, so transactions.statement_id stays NOT NULL
    // without a table rebuild. It has no import batch, so the import trigger never fires for it.
    await this.db.execute(
      "INSERT INTO statements (filename, currency, sha256, transaction_count, imported_at, source, source_format, source_sha256) VALUES ('', ?, ?, 0, ?, 'local', 'manual', ?)",
      [currency, MANUAL_CONTAINER_SHA, now(), MANUAL_CONTAINER_SHA],
    );
    return this.manualContainerId(currency);
  }

  private async categoryKindOf(name: string): Promise<CategoryNode["kind"]> {
    if (isBuiltInCategory(name)) return name === "Income" ? "income" : name === "Transfers" ? "transfer" : name === "Uncategorized" ? "any" : "expense";
    const [row] = await this.db.select<Row>(
      "SELECT m.category_kind, p.category_kind AS parent_kind, p.name AS parent_name FROM category_meta m LEFT JOIN category_meta p ON p.name = m.parent WHERE m.name = ?", [name]);
    if (!row) return "expense";
    if (row.parent_name === "Income") return "income";
    return (str(row.parent_kind) ?? str(row.category_kind) ?? "expense") as CategoryKind;
  }

  private async knownCategory(name: string | null | undefined): Promise<string | null> {
    const clean = normalizeCategoryName(name ?? "");
    if (!clean) return null;
    if (isBuiltInCategory(clean)) return clean;
    const [row] = await this.db.select<Row>("SELECT name FROM custom_categories WHERE name = ?", [clean]);
    return row ? String(row.name) : null;
  }

  /** Validates a manual entry and returns the problems found (empty when it can be saved). */
  async validate(input: EntryInput, editingId?: number): Promise<EntryProblem[]> {
    const category = await this.knownCategory(input.category);
    let refundOf: { amountMinor: number; refundedMinor: number } | null | undefined;
    if (input.kind === "refund" && input.refundOf !== undefined) {
      if (input.refundOf === null) refundOf = null;
      else {
        const [target] = await this.db.select<Row>("SELECT amount_cents FROM transactions WHERE id = ? AND deleted_at IS NULL AND amount_cents < 0", [input.refundOf]);
        const refunded = await this.refundedCents(input.refundOf, editingId);
        refundOf = target ? { amountMinor: Number(target.amount_cents), refundedMinor: refunded } : null;
      }
    }
    const problems = entryProblems({
      kind: input.kind, amountMinor: Number.isFinite(input.amountCents) ? input.amountCents : null, occurredOn: input.occurredOn, accountId: input.accountId, toAccountId: input.toAccountId,
      categoryKind: category ? await this.categoryKindOf(category) : null, refundOf,
    });
    const accountIds = [input.accountId, ...(input.toAccountId ? [input.toAccountId] : [])];
    for (const id of accountIds) {
      if ((await this.db.select<Row>("SELECT 1 FROM accounts WHERE id = ?", [id])).length === 0 && !problems.includes("account_required")) problems.push("account_required");
    }
    return problems;
  }

  private async refundedCents(expenseId: number, exceptRefundId?: number): Promise<number> {
    const [row] = await this.db.select<Row>(
      `SELECT COALESCE(SUM(l.amount_cents), 0) AS total FROM transaction_links l JOIN transactions r ON r.id = l.from_transaction_id
       WHERE l.link_type = 'refund_of' AND l.to_transaction_id = ? AND l.status = 'confirmed' AND r.deleted_at IS NULL AND r.id <> ?`, [expenseId, exceptRefundId ?? -1]);
    return Number(row.total);
  }

  /**
   * Creates a manual entry. Transfers and card payments create two legs and their link in one
   * statement; a refund with `refundOf` creates its link in the same statement. Returns the new ids.
   */
  async createEntry(input: EntryInput, actor = "user", origin: "manual" | "recurring" = "manual", recurrence?: { ruleId: number; on: string }): Promise<number[]> {
    if (!isTransactionKind(input.kind)) throw new LedgerError("invalid_entry", "Unknown kind.", ["kind_invalid"]);
    const problems = await this.validate(input);
    if (problems.length > 0) throw new LedgerError(problems.includes("refund_too_large") ? "refund_too_large" : "invalid_entry", `Cannot save: ${problems.join(", ")}`, problems);
    const account = await this.account(input.accountId);
    const containerId = await this.manualContainerId(account.currency);
    const merchantId = await this.dimensionId("merchant", input.merchant, actor);
    const projectId = await this.dimensionId("project", input.project, actor);
    const stamp = now();
    const time = input.time && /^[0-2]\d:[0-5]\d$/.test(input.time) ? input.time : null;
    const note = input.note?.trim().slice(0, 500) || null;
    const columns = "statement_id, account_id, booked_on, occurred_at_time, description, amount_cents, category, kind, entry_origin, merchant_id, project_id, note, currency, direction, category_source, validation_status, locally_modified, user_locked_fields, recurring_rule_id, recurring_on, link_group, link_hint, link_target_id, updated_at";
    const rowValues = (values: { accountId: number; amount: number; category: string; kind: TransactionKind; description: string; linkGroup?: string | null; linkHint?: string | null; linkTarget?: number | null }) => [
      containerId, values.accountId, input.occurredOn, time, values.description, values.amount, values.category, values.kind, origin, merchantId, projectId, note, account.currency,
      values.amount < 0 ? "debit" : values.amount > 0 ? "credit" : "zero", "user", "user_confirmed", 1, JSON.stringify(["category", "kind"]),
      recurrence?.ruleId ?? null, recurrence?.on ?? null, values.linkGroup ?? null, values.linkHint ?? null, values.linkTarget ?? null, stamp,
    ];
    const group = randomId();
    let params: unknown[];
    let rowsCount: number;
    if (input.kind === "transfer" || input.kind === "card_payment") {
      const to = await this.account(input.toAccountId!);
      const kind = transferKind(to.type);
      const legs = transferLegs(input.amountCents);
      const description = input.description?.trim() || `${account.name} → ${to.name}`;
      params = [
        ...rowValues({ accountId: account.id, amount: legs.from, category: "Transfers", kind, description, linkGroup: group }),
        ...rowValues({ accountId: to.id, amount: legs.to, category: "Transfers", kind, description, linkGroup: group, linkHint: kind }),
      ];
      rowsCount = 2;
    } else {
      const category = categoryKindFor(input.kind) === null ? "Transfers" : (await this.knownCategory(input.category)) ?? (input.kind === "income" ? "Income" : "Uncategorized");
      const amount = input.kind === "adjustment" ? Math.trunc(input.amountCents) : signedAmount(input.kind, input.amountCents);
      const description = input.description?.trim() || (input.merchant?.trim() || category);
      params = rowValues({ accountId: account.id, amount, category, kind: input.kind, description, linkHint: input.kind === "refund" && input.refundOf ? "refund_of" : null, linkTarget: input.kind === "refund" ? input.refundOf ?? null : null });
      rowsCount = 1;
    }
    const perRow = columns.split(",").length;
    let inserted: { lastInsertId?: number };
    try {
      inserted = await this.db.execute(`INSERT INTO transactions (${columns}) VALUES ${Array.from({ length: rowsCount }, () => `(${placeholders(perRow)})`).join(", ")}`, params);
    } catch (error) {
      const message = String((error as Error)?.message ?? error);
      if (message.includes("refund_too_large")) throw new LedgerError("refund_too_large", "The refunds would be larger than the expense.", ["refund_too_large"]);
      if (message.includes("refund_target_invalid")) throw new LedgerError("invalid_entry", "That expense cannot be refunded.", ["refund_target_required"]);
      throw error;
    }
    // A pair is found by its unique link group; a single row by the id SQLite just assigned.
    const ids = rowsCount === 2
      ? (await this.db.select<Row>("SELECT id FROM transactions WHERE link_group = ? ORDER BY id", [group])).map((row) => Number(row.id))
      : [Number(inserted.lastInsertId)];
    if (ids.length !== rowsCount || ids.some((value) => !Number.isFinite(value) || value <= 0)) throw new LedgerError("invalid_entry", "The entry could not be read back.");
    // Clear the insert-time helpers so later edits never re-trigger links.
    await this.db.execute(`UPDATE transactions SET link_group = NULL, link_hint = NULL, link_target_id = NULL WHERE id IN (${placeholders(ids.length)})`, ids);
    if (input.tags && input.tags.length > 0) await this.setTags(ids, input.tags, actor, false);
    await this.db.execute("UPDATE statements SET transaction_count = (SELECT COUNT(*) FROM transactions WHERE statement_id = ?) WHERE id = ?", [containerId, containerId]);
    const detail = await this.entry(ids[0]);
    await this.audit({
      actor, action: "create", subjectType: "transaction", subjectId: detail.uuid, summary: `${input.kind} ${detail.description}`,
      changes: { kind: [null, input.kind], amountCents: [null, detail.amountCents], account: [null, detail.accountName], occurredOn: [null, input.occurredOn], category: [null, detail.category] },
      undo: [{ op: "soft_delete", ids }],
    });
    return ids;
  }

  /** One entry with its links (transfer counterpart, refund target, refunds received). */
  async entry(id: number): Promise<EntryDetail> {
    const [row] = await this.db.select<Row>(`${ENTRY_SELECT} WHERE t.id = ?`, [id]);
    if (!row) throw new LedgerError("not_found", "Entry not found.");
    const links = await this.db.select<Row>("SELECT * FROM transaction_links WHERE (from_transaction_id = ? OR to_transaction_id = ?) AND status = 'confirmed'", [id, id]);
    let counterpart: EntryDetail["counterpart"] = null;
    let refundOf: EntryDetail["refundOf"] = null;
    const refunds: EntryDetail["refunds"] = [];
    for (const link of links) {
      const otherId = Number(link.from_transaction_id) === id ? Number(link.to_transaction_id) : Number(link.from_transaction_id);
      if (!otherId) continue;
      const [other] = await this.db.select<Row>("SELECT t.id, t.account_id, t.amount_cents, t.description, t.booked_on, t.deleted_at, a.name AS account_name FROM transactions t LEFT JOIN accounts a ON a.id = t.account_id WHERE t.id = ?", [otherId]);
      if (!other) continue;
      if (link.link_type === "transfer" || link.link_type === "card_payment") {
        counterpart = { id: otherId, accountId: Number(other.account_id), accountName: String(other.account_name ?? ""), amountCents: Number(other.amount_cents) };
      } else if (link.link_type === "refund_of") {
        if (Number(link.from_transaction_id) === id) refundOf = { id: otherId, description: String(other.description), amountCents: Number(other.amount_cents) };
        else if (other.deleted_at === null) refunds.push({ id: otherId, amountCents: Number(link.amount_cents ?? other.amount_cents), occurredOn: String(other.booked_on) });
      }
    }
    const amountCents = Number(row.amount_cents);
    const kind = (isTransactionKind(row.kind) ? row.kind : "expense") as TransactionKind;
    return {
      id: Number(row.id), uuid: String(row.uuid), kind, accountId: Number(row.account_id), accountName: String(row.account_name ?? ""), amountCents, occurredOn: String(row.booked_on),
      time: str(row.occurred_at_time), category: String(row.category), description: String(row.description), originalDescription: String(row.original_description ?? row.description),
      note: str(row.note), merchant: str(row.merchant_name), project: str(row.project_name), tags: row.tag_names ? String(row.tag_names).split("\u001f") : [],
      origin: String(row.entry_origin ?? "import"), excluded: Number(row.excluded) === 1, deletedAt: str(row.deleted_at), lockedFields: parseLocked(row.user_locked_fields),
      categorySource: String(row.category_source ?? "legacy"), counterpart, refundOf, refunds,
      refundableCents: kind === "expense" && amountCents < 0 ? Math.max(0, -amountCents - refunds.reduce((sum, item) => sum + item.amountCents, 0)) : 0,
    };
  }

  /**
   * Edits an entry. For a transfer both legs change together (amount, date, accounts, note). The
   * bank's original text never changes; edited fields are locked against automation.
   */
  async updateEntry(id: number, input: EntryInput, actor = "user"): Promise<void> {
    const before = await this.entry(id);
    if (before.deletedAt) throw new LedgerError("not_found", "Restore the entry from the trash first.");
    const problems = await this.validate({ ...input, refundOf: input.kind === "refund" && input.refundOf !== undefined ? input.refundOf : undefined }, id);
    if (problems.length > 0) throw new LedgerError(problems.includes("refund_too_large") ? "refund_too_large" : "invalid_entry", `Cannot save: ${problems.join(", ")}`, problems);
    const merchantId = await this.dimensionId("merchant", input.merchant, actor);
    const projectId = await this.dimensionId("project", input.project, actor);
    const time = input.time && /^[0-2]\d:[0-5]\d$/.test(input.time) ? input.time : null;
    const note = input.note?.trim().slice(0, 500) || null;
    const stamp = now();
    const locked = new Set(before.lockedFields);
    const undo: UndoStep[] = [];
    const snapshot = async (entryId: number) => {
      const [row] = await this.db.select<Row>("SELECT category, kind, description, merchant_id, project_id, note, account_id, amount_cents, booked_on, occurred_at_time, user_locked_fields, category_source FROM transactions WHERE id = ?", [entryId]);
      return row;
    };
    if (input.kind === "transfer" || input.kind === "card_payment") {
      const fromId = before.amountCents < 0 ? before.id : before.counterpart?.id ?? before.id;
      const toId = before.amountCents < 0 ? before.counterpart?.id ?? null : before.id;
      const to = await this.account(input.toAccountId!);
      const kind = transferKind(to.type);
      const legs = transferLegs(input.amountCents);
      const from = await this.account(input.accountId);
      const description = input.description?.trim() || `${from.name} → ${to.name}`;
      for (const legId of [fromId, toId].filter((value): value is number => value !== null)) {
        const row = await snapshot(legId);
        undo.push({ op: "set", table: "transactions", id: legId, fields: { kind: row.kind, description: row.description, merchant_id: row.merchant_id, project_id: row.project_id, note: row.note, account_id: row.account_id } });
      }
      // One statement updates both legs.
      const ids = [fromId, ...(toId ? [toId] : [])];
      await this.db.execute(
        `UPDATE transactions SET
           account_id = CASE id WHEN ? THEN ? ELSE ? END,
           amount_cents = CASE id WHEN ? THEN ? ELSE ? END,
           direction = CASE id WHEN ? THEN 'debit' ELSE 'credit' END,
           booked_on = ?, occurred_at_time = ?, kind = ?, category = 'Transfers', description = ?, note = ?, merchant_id = ?, project_id = ?, locally_modified = 1, updated_at = ?
         WHERE id IN (${placeholders(ids.length)})`,
        [fromId, from.id, to.id, fromId, legs.from, legs.to, fromId, input.occurredOn, time, kind, description, note, merchantId, projectId, stamp, ...ids],
      );
      await this.db.execute(`UPDATE transaction_links SET link_type = ?, amount_cents = ? WHERE from_transaction_id = ? AND link_type IN ('transfer', 'card_payment')`, [kind, legs.to, fromId]);
      if (input.tags) await this.setTags(ids, input.tags, actor, false);
    } else {
      const category = categoryKindFor(input.kind) === null ? "Transfers" : (await this.knownCategory(input.category)) ?? (input.kind === "income" ? "Income" : "Uncategorized");
      const amount = input.kind === "adjustment" ? Math.trunc(input.amountCents) : signedAmount(input.kind, input.amountCents);
      const description = input.description?.trim() || before.description;
      const row = await snapshot(id);
      undo.push({ op: "set", table: "transactions", id, fields: { category: row.category, kind: row.kind, description: row.description, merchant_id: row.merchant_id, project_id: row.project_id, note: row.note, account_id: row.account_id, user_locked_fields: row.user_locked_fields, category_source: row.category_source } });
      if (category !== before.category) locked.add("category");
      if (input.kind !== before.kind) locked.add("kind");
      if (description !== before.description) locked.add("description");
      if ((input.merchant ?? null) !== before.merchant) locked.add("merchant");
      if ((input.project ?? null) !== before.project) locked.add("project");
      if (input.accountId !== before.accountId) locked.add("account");
      // Imported rows keep the bank's amount and date (they are evidence); manual entries change freely.
      const manual = before.origin === "manual" || before.origin === "recurring";
      await this.db.execute(
        `UPDATE transactions SET account_id = ?, ${manual ? "amount_cents = ?, booked_on = ?, direction = ?," : ""} occurred_at_time = ?, kind = ?, category = ?, description = ?, note = ?, merchant_id = ?, project_id = ?,
           category_source = CASE WHEN category <> ? THEN 'user' ELSE category_source END, user_locked_fields = ?, locally_modified = 1, tax_review = CASE WHEN ? = 'Business' THEN 1 ELSE tax_review END, updated_at = ? WHERE id = ?`,
        [input.accountId, ...(manual ? [amount, input.occurredOn, amount < 0 ? "debit" : amount > 0 ? "credit" : "zero"] : []), time, input.kind, category, description, note, merchantId, projectId,
          category, JSON.stringify([...locked]), category, stamp, id],
      );
      if (input.kind === "refund" && input.refundOf !== undefined) {
        await this.db.execute("DELETE FROM transaction_links WHERE from_transaction_id = ? AND link_type = 'refund_of'", [id]);
        if (input.refundOf) {
          await this.db.execute("INSERT INTO transaction_links (uuid, link_type, from_transaction_id, to_transaction_id, amount_cents, status, decided_by, created_at) VALUES (?, 'refund_of', ?, ?, ?, 'confirmed', 'user', ?)",
            [randomId(), id, input.refundOf, manual ? amount : before.amountCents, stamp]);
        }
      } else if (before.kind === "refund" && input.kind !== "refund") {
        await this.db.execute("DELETE FROM transaction_links WHERE from_transaction_id = ? AND link_type = 'refund_of'", [id]);
      }
      if (input.tags) await this.setTags([id], input.tags, actor, false);
    }
    const after = await this.entry(id);
    const changes: Record<string, [unknown, unknown]> = {};
    for (const key of ["kind", "amountCents", "occurredOn", "category", "description", "note", "merchant", "project", "accountName"] as const) {
      if (JSON.stringify(before[key]) !== JSON.stringify(after[key])) changes[key] = [before[key], after[key]];
    }
    if (JSON.stringify(before.tags) !== JSON.stringify(after.tags)) changes.tags = [before.tags, after.tags];
    await this.audit({ actor, action: "update", subjectType: "transaction", subjectId: before.uuid, summary: after.description, changes, undo });
  }

  /** The entry and, for a transfer, its other leg (they always move together). */
  private async withCounterparts(ids: readonly number[]): Promise<number[]> {
    const all = new Set(ids);
    for (const id of ids) {
      const links = await this.db.select<Row>("SELECT from_transaction_id, to_transaction_id FROM transaction_links WHERE link_type IN ('transfer', 'card_payment') AND status = 'confirmed' AND (from_transaction_id = ? OR to_transaction_id = ?)", [id, id]);
      for (const link of links) {
        all.add(Number(link.from_transaction_id));
        if (link.to_transaction_id !== null) all.add(Number(link.to_transaction_id));
      }
    }
    return [...all];
  }

  /** Moves entries to the trash (回收站). A transfer's two legs go together. Returns the ids moved. */
  async deleteEntries(ids: readonly number[], actor = "user", batchId: string | null = null): Promise<number[]> {
    const targets = await this.withCounterparts(ids);
    if (targets.length === 0) return [];
    const live = (await this.db.select<Row>(`SELECT id, uuid, description FROM transactions WHERE id IN (${placeholders(targets.length)}) AND deleted_at IS NULL`, targets));
    const liveIds = live.map((row) => Number(row.id));
    if (liveIds.length === 0) return [];
    const stamp = now();
    await this.db.execute(`UPDATE transactions SET deleted_at = ?, locally_modified = 1, updated_at = ? WHERE id IN (${placeholders(liveIds.length)})`, [stamp, stamp, ...liveIds]);
    await this.audit({ actor, action: liveIds.length > 1 ? "batch_delete" : "delete", subjectType: "transaction", subjectId: liveIds.length === 1 ? String(live[0].uuid) : null, batchId,
      summary: liveIds.length === 1 ? String(live[0].description) : `${liveIds.length} entries`, undo: [{ op: "restore", ids: liveIds }] });
    return liveIds;
  }

  async restoreEntries(ids: readonly number[], actor = "user"): Promise<number[]> {
    const targets = await this.withCounterparts(ids);
    const trashed = (await this.db.select<Row>(`SELECT id FROM transactions WHERE id IN (${placeholders(targets.length || 1)}) AND deleted_at IS NOT NULL`, targets.length ? targets : [-1])).map((row) => Number(row.id));
    if (trashed.length === 0) return [];
    await this.db.execute(`UPDATE transactions SET deleted_at = NULL, updated_at = ? WHERE id IN (${placeholders(trashed.length)})`, [now(), ...trashed]);
    await this.audit({ actor, action: "restore", subjectType: "transaction", summary: `${trashed.length} entries`, undo: [{ op: "soft_delete", ids: trashed }] });
    return trashed;
  }

  /** Permanently removes entries that are already in the trash. Cannot be undone. */
  async purgeEntries(ids: readonly number[], actor = "user"): Promise<number> {
    const targets = await this.withCounterparts(ids);
    const trashed = (await this.db.select<Row>(`SELECT id, uuid, statement_id FROM transactions WHERE id IN (${placeholders(targets.length || 1)}) AND deleted_at IS NOT NULL`, targets.length ? targets : [-1]));
    if (trashed.length === 0) throw new LedgerError("not_in_trash", "Only entries in the trash can be deleted for good.");
    const list = trashed.map((row) => Number(row.id));
    await this.db.execute(`DELETE FROM transaction_links WHERE from_transaction_id IN (${placeholders(list.length)}) OR to_transaction_id IN (${placeholders(list.length)})`, [...list, ...list]);
    await this.db.execute(`DELETE FROM transaction_tags WHERE transaction_id IN (${placeholders(list.length)})`, list);
    await this.db.execute(`DELETE FROM transactions WHERE id IN (${placeholders(list.length)})`, list);
    for (const statementId of new Set(trashed.map((row) => Number(row.statement_id)))) {
      await this.db.execute("UPDATE statements SET transaction_count = (SELECT COUNT(*) FROM transactions WHERE statement_id = ?) WHERE id = ? AND source_format = 'manual'", [statementId, statementId]);
    }
    await this.audit({ actor, action: "purge", subjectType: "transaction", summary: `${list.length} entries`, changes: { ids: [trashed.map((row) => String(row.uuid)), null] } });
    return list.length;
  }

  /** Empties the trash. Returns how many entries were removed for good. */
  async emptyTrash(actor = "user"): Promise<number> {
    const ids = (await this.db.select<Row>("SELECT id FROM transactions WHERE deleted_at IS NOT NULL")).map((row) => Number(row.id));
    return ids.length ? this.purgeEntries(ids, actor) : 0;
  }

  async trash(): Promise<EntryDetail[]> {
    const rows = await this.db.select<Row>("SELECT id FROM transactions WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC, id DESC");
    const out: EntryDetail[] = [];
    for (const row of rows) out.push(await this.entry(Number(row.id)));
    return out;
  }

  /** A new manual entry with the same fields (复制). Transfers copy both legs. Returns the new ids. */
  async duplicateEntry(id: number, occurredOn?: string, actor = "user"): Promise<number[]> {
    const entry = await this.entry(id);
    const transfer = entry.kind === "transfer" || entry.kind === "card_payment";
    const fromLeg = transfer && entry.amountCents > 0 && entry.counterpart ? entry.counterpart : null;
    return this.createEntry({
      kind: entry.kind === "opening_balance" || entry.kind === "ignored" ? "adjustment" : entry.kind,
      amountCents: entry.kind === "adjustment" ? entry.amountCents : Math.abs(entry.amountCents),
      occurredOn: occurredOn ?? entry.occurredOn, time: entry.time,
      accountId: fromLeg ? fromLeg.accountId : entry.accountId, toAccountId: transfer ? (fromLeg ? entry.accountId : entry.counterpart?.accountId ?? null) : null,
      category: entry.category, description: entry.description, note: entry.note, merchant: entry.merchant, project: entry.project, tags: entry.tags,
      refundOf: entry.kind === "refund" && entry.refundOf && entry.refundOf.amountCents + entry.amountCents <= 0 ? null : undefined,
    }, actor);
  }

  /** Batch edit (批量编辑): category, merchant, project, account, tags. Locks the fields set. */
  async batchUpdate(ids: readonly number[], patch: { category?: string; merchant?: string | null; project?: string | null; accountId?: number; addTags?: string[]; removeTags?: string[] }, actor = "user", batchId: string | null = null, extra: { categorySource?: string; confidence?: number | null; model?: string | null; lock?: boolean } = {}): Promise<number> {
    if (ids.length === 0) return 0;
    const category = patch.category !== undefined ? await this.knownCategory(patch.category) : undefined;
    if (patch.category !== undefined && !category) throw new LedgerError("invalid_entry", "Unknown category.", ["category_kind"]);
    const merchantId = patch.merchant !== undefined ? await this.dimensionId("merchant", patch.merchant, actor) : undefined;
    const projectId = patch.project !== undefined ? await this.dimensionId("project", patch.project, actor) : undefined;
    let changed = 0;
    for (const id of ids) {
      const [row] = await this.db.select<Row>("SELECT * FROM transactions WHERE id = ? AND deleted_at IS NULL", [id]);
      if (!row) continue;
      const kind = String(row.kind) as TransactionKind;
      const locked = new Set(parseLocked(row.user_locked_fields));
      const sets: string[] = [];
      const params: unknown[] = [];
      const undoFields: Record<string, unknown> = {};
      // Automation (AI, rules) never overrides what a person chose.
      const respect = extra.lock === false;
      if (category !== undefined && category !== null && categoryKindFor(kind) !== null && !(respect && locked.has("category"))) {
        sets.push("category = ?", "category_source = ?", "category_confidence = ?", "category_model = ?", "tax_review = CASE WHEN ? = 'Business' THEN 1 ELSE tax_review END");
        params.push(category, extra.categorySource ?? "user", extra.confidence ?? null, extra.model ?? null, category);
        Object.assign(undoFields, { category: row.category, category_source: row.category_source, category_confidence: row.category_confidence, category_model: row.category_model, tax_review: row.tax_review });
        if (!respect) locked.add("category");
      }
      if (merchantId !== undefined && !(respect && locked.has("merchant"))) { sets.push("merchant_id = ?"); params.push(merchantId); undoFields.merchant_id = row.merchant_id; if (!respect) locked.add("merchant"); }
      if (projectId !== undefined && !(respect && locked.has("project"))) { sets.push("project_id = ?"); params.push(projectId); undoFields.project_id = row.project_id; if (!respect) locked.add("project"); }
      if (patch.accountId !== undefined && kind !== "transfer" && kind !== "card_payment") { sets.push("account_id = ?"); params.push(patch.accountId); undoFields.account_id = row.account_id; locked.add("account"); }
      if (sets.length > 0) {
        undoFields.user_locked_fields = row.user_locked_fields;
        undoFields.locally_modified = row.locally_modified;
        await this.db.execute(`UPDATE transactions SET ${sets.join(", ")}, user_locked_fields = ?, locally_modified = 1, updated_at = ? WHERE id = ?`, [...params, JSON.stringify([...locked]), now(), id]);
        await this.audit({ actor, action: "batch_update", subjectType: "transaction", subjectId: String(row.uuid), batchId, summary: String(row.description),
          changes: Object.fromEntries(Object.keys(undoFields).filter((key) => key !== "user_locked_fields" && key !== "locally_modified" && key !== "tax_review").map((key) => [key, [undoFields[key], null]])),
          undo: [{ op: "set", table: "transactions", id, fields: undoFields }] });
        changed += 1;
      }
    }
    if (patch.addTags?.length) await this.setTags(ids, patch.addTags, actor, true);
    if (patch.removeTags?.length) {
      for (const name of patch.removeTags) {
        const tagId = await this.dimensionId("tag", name, actor);
        if (tagId) await this.db.execute(`DELETE FROM transaction_tags WHERE tag_id = ? AND transaction_id IN (${placeholders(ids.length)})`, [tagId, ...ids]);
      }
    }
    return changed;
  }

  /** Sets (or with `add`, adds) tags on entries. */
  async setTags(ids: readonly number[], names: readonly string[], actor = "user", add = false): Promise<void> {
    const tagIds: number[] = [];
    for (const name of names) {
      const tagId = await this.dimensionId("tag", name, actor);
      if (tagId !== null && !tagIds.includes(tagId)) tagIds.push(tagId);
    }
    for (const id of ids) {
      if (!add) await this.db.execute("DELETE FROM transaction_tags WHERE transaction_id = ?", [id]);
      for (const tagId of tagIds) await this.db.execute("INSERT OR IGNORE INTO transaction_tags (transaction_id, tag_id) VALUES (?, ?)", [id, tagId]);
    }
  }

  /** Expenses that can still be refunded, newest first (for the refund form). */
  async refundCandidates(options: { accountId?: number; query?: string; limit?: number } = {}): Promise<Array<{ id: number; occurredOn: string; description: string; amountCents: number; refundableCents: number; accountName: string; category: string }>> {
    const params: unknown[] = [];
    let where = "t.deleted_at IS NULL AND t.kind = 'expense' AND t.amount_cents < 0";
    if (options.accountId) { where += " AND t.account_id = ?"; params.push(options.accountId); }
    if (options.query) { where += " AND t.description LIKE ?"; params.push(`%${options.query}%`); }
    params.push(options.limit ?? 50);
    const rows = await this.db.select<Row>(`SELECT t.id, t.booked_on, t.description, t.amount_cents, t.category, a.name AS account_name,
        -t.amount_cents - COALESCE((SELECT SUM(l.amount_cents) FROM transaction_links l JOIN transactions r ON r.id = l.from_transaction_id
          WHERE l.link_type = 'refund_of' AND l.to_transaction_id = t.id AND l.status = 'confirmed' AND r.deleted_at IS NULL), 0) AS refundable
      FROM transactions t LEFT JOIN accounts a ON a.id = t.account_id WHERE ${where} ORDER BY t.booked_on DESC, t.id DESC LIMIT ?`, params);
    return rows.filter((row) => Number(row.refundable) > 0).map((row) => ({
      id: Number(row.id), occurredOn: String(row.booked_on), description: String(row.description), amountCents: Number(row.amount_cents), refundableCents: Number(row.refundable),
      accountName: String(row.account_name ?? ""), category: String(row.category),
    }));
  }

  /** Links an existing money-in row to the expense it refunds (also used by "Organize with AI"). */
  async linkRefund(refundId: number, expenseId: number, actor = "user", batchId: string | null = null, decidedBy: "user" | "ai" | "rule" = "user"): Promise<void> {
    const refund = await this.entry(refundId);
    const expense = await this.entry(expenseId);
    if (refund.deletedAt || expense.deletedAt) throw new LedgerError("not_found", "Restore the entry from the trash first.");
    if (refund.amountCents <= 0 || expense.amountCents >= 0) throw new LedgerError("invalid_entry", "A refund links money in to an expense.", ["refund_target_required"]);
    if (refund.amountCents > (await this.entry(expenseId)).refundableCents) throw new LedgerError("refund_too_large", "The refunds would be larger than the expense.", ["refund_too_large"]);
    const [row] = await this.db.select<Row>("SELECT kind, category, user_locked_fields, category_source FROM transactions WHERE id = ?", [refundId]);
    await this.db.execute("UPDATE transactions SET kind = 'refund', category = ?, category_source = CASE WHEN ? = 'ai' THEN 'ai' ELSE 'user' END, locally_modified = 1, updated_at = ? WHERE id = ?",
      [expense.category, decidedBy, now(), refundId]);
    await this.db.execute("INSERT INTO transaction_links (uuid, link_type, from_transaction_id, to_transaction_id, amount_cents, status, decided_by, created_at) VALUES (?, 'refund_of', ?, ?, ?, 'confirmed', ?, ?)",
      [randomId(), refundId, expenseId, refund.amountCents, decidedBy, now()]);
    const [link] = await this.db.select<Row>("SELECT id FROM transaction_links WHERE from_transaction_id = ? AND to_transaction_id = ? AND link_type = 'refund_of'", [refundId, expenseId]);
    await this.audit({ actor, action: "link", subjectType: "transaction", subjectId: refund.uuid, batchId, summary: `refund of ${expense.description}`,
      changes: { kind: [row.kind, "refund"], category: [row.category, expense.category] },
      undo: [{ op: "delete_link", id: Number(link.id) }, { op: "set", table: "transactions", id: refundId, fields: { kind: row.kind, category: row.category, category_source: row.category_source, user_locked_fields: row.user_locked_fields } }] });
  }

  /** Pairs two existing rows (one out, one in, opposite amounts, different accounts) as a transfer or card payment. */
  async linkTransfer(outId: number, inId: number, actor = "user", batchId: string | null = null, decidedBy: "user" | "ai" | "rule" = "user"): Promise<void> {
    const out = await this.entry(outId);
    const inn = await this.entry(inId);
    if (out.deletedAt || inn.deletedAt) throw new LedgerError("not_found", "Restore the entry from the trash first.");
    if (out.amountCents >= 0 || inn.amountCents <= 0 || out.amountCents + inn.amountCents !== 0 || out.accountId === inn.accountId) {
      throw new LedgerError("invalid_entry", "A transfer joins money out and the same amount in, in two different accounts.", ["accounts_same"]);
    }
    const toAccount = await this.account(inn.accountId);
    const kind = transferKind(toAccount.type);
    const rows = await this.db.select<Row>("SELECT id, kind, category, category_source, user_locked_fields FROM transactions WHERE id IN (?, ?)", [outId, inId]);
    await this.db.execute("UPDATE transactions SET kind = ?, category = 'Transfers', locally_modified = 1, updated_at = ? WHERE id IN (?, ?)", [kind, now(), outId, inId]);
    await this.db.execute("INSERT OR IGNORE INTO transaction_links (uuid, link_type, from_transaction_id, to_transaction_id, amount_cents, status, decided_by, created_at) VALUES (?, ?, ?, ?, ?, 'confirmed', ?, ?)",
      [randomId(), kind, outId, inId, inn.amountCents, decidedBy, now()]);
    const [link] = await this.db.select<Row>("SELECT id FROM transaction_links WHERE from_transaction_id = ? AND to_transaction_id = ? AND link_type = ?", [outId, inId, kind]);
    await this.audit({ actor, action: "link", subjectType: "transaction", subjectId: out.uuid, batchId, summary: `${kind}: ${out.accountName} → ${inn.accountName}`,
      changes: { kind: [`${out.kind}/${inn.kind}`, kind] },
      undo: [{ op: "delete_link", id: Number(link.id) }, ...rows.map((row): UndoStep => ({ op: "set", table: "transactions", id: Number(row.id), fields: { kind: row.kind, category: row.category, category_source: row.category_source, user_locked_fields: row.user_locked_fields } }))] });
  }

  /** Marks an entry as the same economic event as another (the duplicate goes to the trash; the link is kept for audit). */
  async markDuplicate(duplicateId: number, ofId: number, actor = "user", batchId: string | null = null, decidedBy: "user" | "ai" | "rule" = "user"): Promise<void> {
    const duplicate = await this.entry(duplicateId);
    if (duplicate.deletedAt || (await this.entry(ofId)).deletedAt) throw new LedgerError("not_found", "Restore the entry from the trash first.");
    await this.db.execute("INSERT OR IGNORE INTO transaction_links (uuid, link_type, from_transaction_id, to_transaction_id, status, decided_by, created_at) VALUES (?, 'duplicate_of', ?, ?, 'confirmed', ?, ?)",
      [randomId(), duplicateId, ofId, decidedBy, now()]);
    const [link] = await this.db.select<Row>("SELECT id FROM transaction_links WHERE from_transaction_id = ? AND to_transaction_id = ? AND link_type = 'duplicate_of'", [duplicateId, ofId]);
    await this.db.execute("UPDATE transactions SET deleted_at = ?, locally_modified = 1, updated_at = ? WHERE id = ?", [now(), now(), duplicateId]);
    await this.audit({ actor, action: "merge", subjectType: "transaction", subjectId: duplicate.uuid, batchId, summary: `duplicate: ${duplicate.description}`,
      undo: [{ op: "restore", ids: [duplicateId] }, { op: "delete_link", id: Number(link.id) }] });
  }

  /** Sets an entry's kind (e.g. "this was a refund, not income"); keeps or fixes the category. */
  async setKind(id: number, kind: TransactionKind, actor = "user", batchId: string | null = null, extra: { categorySource?: string; lock?: boolean } = {}): Promise<void> {
    const [row] = await this.db.select<Row>("SELECT * FROM transactions WHERE id = ?", [id]);
    if (!row || row.deleted_at !== null) throw new LedgerError("not_found", "Entry not found.");
    const locked = new Set(parseLocked(row.user_locked_fields));
    if (extra.lock === false && locked.has("kind")) return;
    const category = categoryKindFor(kind) === null ? "Transfers" : String(row.category) === "Transfers" || (kind !== "income" && String(row.category) === "Income") ? "Uncategorized" : String(row.category);
    if (extra.lock !== false) locked.add("kind");
    await this.db.execute("UPDATE transactions SET kind = ?, category = ?, category_source = CASE WHEN category <> ? THEN ? ELSE category_source END, user_locked_fields = ?, locally_modified = 1, updated_at = ? WHERE id = ?",
      [kind, category, category, extra.categorySource ?? "user", JSON.stringify([...locked]), now(), id]);
    await this.audit({ actor, action: "update", subjectType: "transaction", subjectId: String(row.uuid), batchId, summary: String(row.description), changes: { kind: [row.kind, kind], category: [row.category, category] },
      undo: [{ op: "set", table: "transactions", id, fields: { kind: row.kind, category: row.category, category_source: row.category_source, user_locked_fields: row.user_locked_fields } }] });
  }

  // ------------------------------------------------------------------------------ ledger views

  /** Entries for the pure domain functions (live and trashed; trashed are marked deleted). */
  async ledgerEntries(): Promise<LedgerEntry[]> {
    const rows = await this.db.select<Row>(`SELECT t.id, t.account_id, t.booked_on, t.amount_cents, t.kind, t.category, t.excluded, t.deleted_at, m.name AS merchant, p.name AS project,
        (SELECT group_concat(g.name, char(31)) FROM transaction_tags tt JOIN tags g ON g.id = tt.tag_id WHERE tt.transaction_id = t.id) AS tag_names
      FROM transactions t LEFT JOIN merchants m ON m.id = t.merchant_id LEFT JOIN projects p ON p.id = t.project_id`);
    return rows.map((row) => ({
      id: Number(row.id), accountId: row.account_id === null ? null : Number(row.account_id), occurredOn: String(row.booked_on), amountMinor: Number(row.amount_cents),
      kind: (isTransactionKind(row.kind) ? row.kind : "expense") as TransactionKind, category: String(row.category), excluded: Number(row.excluded) === 1, deleted: row.deleted_at !== null,
      merchant: str(row.merchant), project: str(row.project), tags: row.tag_names ? String(row.tag_names).split("\u001f") : [],
    }));
  }

  async ledgerAccounts(): Promise<LedgerAccount[]> {
    return (await this.accounts({ includeArchived: true })).map((account) => ({ id: account.id, type: account.type, openingBalanceMinor: account.openingBalanceCents, includeInNetWorth: account.includeInNetWorth, archived: account.archived }));
  }

  async netWorth(asOf?: string | null) {
    return netWorth(await this.ledgerAccounts(), await this.ledgerEntries(), asOf);
  }

  /** Month-end net worth for the last `months` months (oldest first). */
  async netWorthHistory(months = 12, today = new Date().toISOString().slice(0, 10)): Promise<Array<{ month: string; assetsMinor: number; liabilitiesMinor: number; netWorthMinor: number }>> {
    const accounts = await this.ledgerAccounts();
    const entries = await this.ledgerEntries();
    const out = [];
    const [y, m] = today.split("-").map(Number);
    for (let back = months - 1; back >= 0; back -= 1) {
      const total = y * 12 + (m - 1) - back;
      const year = Math.floor(total / 12);
      const month = (total % 12) + 1;
      const end = new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);
      out.push({ month: `${year}-${String(month).padStart(2, "0")}`, ...netWorth(accounts, entries, end < today ? end : today) });
    }
    return out;
  }

  /** Income/expense grouped by a dimension over a date range (refunds net within their group). */
  async report(dimension: "category" | "account" | "merchant" | "project" | "tag" | "month", range: { from?: string | null; to?: string | null } = {}): Promise<{ incomeMinor: number; expenseMinor: number; netMinor: number; rows: Array<{ key: string; incomeMinor: number; expenseMinor: number; count: number }> }> {
    const entries = await this.ledgerEntries();
    const accountNames = new Map((await this.accounts({ includeArchived: true })).map((account) => [account.id, account.name]));
    const total = totals(entries, range);
    const groups = new Map<string, { key: string; incomeMinor: number; expenseMinor: number; count: number }>();
    const add = (key: string, entry: LedgerEntry) => {
      const group = groups.get(key) ?? { key, incomeMinor: 0, expenseMinor: 0, count: 0 };
      const result = totals([entry]);
      group.incomeMinor += result.incomeMinor;
      group.expenseMinor += result.expenseMinor;
      group.count += 1;
      groups.set(key, group);
    };
    for (const entry of entries) {
      if (totals([entry], range).incomeMinor === 0 && totals([entry], range).expenseMinor === 0) continue;
      if (dimension === "tag") for (const tag of entry.tags?.length ? entry.tags : [""]) add(tag, entry);
      else add(dimension === "category" ? entry.category : dimension === "account" ? accountNames.get(Number(entry.accountId)) ?? "" : dimension === "month" ? entry.occurredOn.slice(0, 7)
        : String((dimension === "merchant" ? entry.merchant : entry.project) ?? ""), entry);
    }
    const rows = [...groups.values()].sort((a, b) => (dimension === "month" ? a.key.localeCompare(b.key) : b.expenseMinor + b.incomeMinor - (a.expenseMinor + a.incomeMinor)));
    return { incomeMinor: total.incomeMinor, expenseMinor: total.expenseMinor, netMinor: total.netMinor, rows };
  }

  // ---------------------------------------------------------------------------------- budgets

  async budgets(on = new Date().toISOString().slice(0, 10)): Promise<Budget[]> {
    const monthStart = await this.monthStartDay();
    const rows = await this.db.select<Row>("SELECT b.*, p.name AS project_name FROM budgets b LEFT JOIN projects p ON p.id = b.project_id ORDER BY b.period, b.category IS NOT NULL, b.category, b.id");
    const entries = await this.ledgerEntries();
    return rows.map((row) => {
      const period = String(row.period) as BudgetPeriod;
      const bounds = periodBounds(on, period, monthStart);
      const scoped = entries.filter((entry) => (row.category === null || entry.category.toLowerCase() === String(row.category).toLowerCase()) && (row.project_id === null || entry.project === row.project_name));
      const spent = totals(scoped, bounds).expenseMinor;
      return {
        id: Number(row.id), uuid: String(row.uuid), period, category: str(row.category), projectId: num(row.project_id), projectName: str(row.project_name), amountCents: Number(row.amount_cents),
        alertPercent: Number(row.alert_percent), from: bounds.from, to: bounds.to, status: budgetStatus(spent, Number(row.amount_cents), Number(row.alert_percent)),
      };
    });
  }

  async saveBudget(input: { id?: number; period: BudgetPeriod; category?: string | null; projectId?: number | null; amountCents: number; alertPercent?: number }, actor = "user"): Promise<void> {
    if (!["month", "year"].includes(input.period) || !Number.isInteger(input.amountCents) || input.amountCents <= 0) throw new LedgerError("invalid_budget", "Enter an amount above zero.");
    const alert = Math.min(100, Math.max(1, Math.trunc(input.alertPercent ?? 90)));
    const category = input.category ? await this.knownCategory(input.category) : null;
    if (input.category && !category) throw new LedgerError("invalid_budget", "Unknown category.");
    const stamp = now();
    try {
      if (input.id) {
        await this.db.execute("UPDATE budgets SET period = ?, category = ?, project_id = ?, amount_cents = ?, alert_percent = ?, updated_at = ? WHERE id = ?", [input.period, category, input.projectId ?? null, input.amountCents, alert, stamp, input.id]);
      } else {
        await this.db.execute("INSERT INTO budgets (uuid, period, category, project_id, amount_cents, alert_percent, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
          [randomId(), input.period, category, input.projectId ?? null, input.amountCents, alert, stamp, stamp]);
      }
    } catch (error) {
      if (String((error as Error).message).includes("UNIQUE")) throw new LedgerError("invalid_budget", "There is already a budget for this.");
      throw error;
    }
    await this.audit({ actor, action: input.id ? "update" : "create", subjectType: "budget", subjectId: input.id ?? null, summary: `${input.period} ${category ?? "all"}`, changes: { amountCents: [null, input.amountCents] } });
  }

  async deleteBudget(id: number, actor = "user"): Promise<void> {
    await this.db.execute("DELETE FROM budgets WHERE id = ?", [id]);
    await this.audit({ actor, action: "delete", subjectType: "budget", subjectId: id });
  }

  // -------------------------------------------------------------------------------- recurring

  async recurringRules(): Promise<RecurringRule[]> {
    const rows = await this.db.select<Row>("SELECT * FROM recurring_rules ORDER BY paused, next_on IS NULL, next_on, id");
    return rows.map((row) => ({
      id: Number(row.id), uuid: String(row.uuid), name: String(row.name), template: JSON.parse(String(row.template)) as RecurringTemplate, frequency: String(row.frequency) as Frequency,
      interval: Number(row.interval), startOn: String(row.start_on), endOn: str(row.end_on), nextOn: str(row.next_on), autoPost: Number(row.auto_post) === 1, paused: Number(row.paused) === 1,
    }));
  }

  async saveRecurringRule(input: { id?: number; name: string; template: RecurringTemplate; frequency: Frequency; interval?: number; startOn: string; endOn?: string | null; autoPost?: boolean }, actor = "user"): Promise<number> {
    const name = cleanName(input.name);
    if (!name) throw new LedgerError("invalid_name", "Give the schedule a name.");
    if (!FREQUENCIES.includes(input.frequency) || !/^\d{4}-\d{2}-\d{2}$/.test(input.startOn) || (input.endOn && input.endOn < input.startOn)) throw new LedgerError("invalid_schedule", "Check the dates and frequency.");
    const interval = Math.min(365, Math.max(1, Math.trunc(input.interval ?? 1)));
    const problems = await this.validate({ ...input.template, occurredOn: input.startOn, refundOf: undefined });
    if (problems.length > 0) throw new LedgerError("invalid_entry", `Cannot save: ${problems.join(", ")}`, problems);
    const stamp = now();
    const template = JSON.stringify({ ...input.template, tags: input.template.tags ?? [] });
    if (input.id) {
      const [existing] = await this.db.select<Row>("SELECT next_on, start_on FROM recurring_rules WHERE id = ?", [input.id]);
      if (!existing) throw new LedgerError("not_found", "Schedule not found.");
      const nextOn = String(existing.start_on) === input.startOn && existing.next_on ? String(existing.next_on) : input.startOn;
      await this.db.execute("UPDATE recurring_rules SET name = ?, template = ?, frequency = ?, interval = ?, start_on = ?, end_on = ?, next_on = ?, auto_post = ?, updated_at = ? WHERE id = ?",
        [name, template, input.frequency, interval, input.startOn, input.endOn ?? null, nextOn, input.autoPost ? 1 : 0, stamp, input.id]);
      await this.audit({ actor, action: "update", subjectType: "recurring_rule", subjectId: input.id, summary: name });
      return input.id;
    }
    const uuid = randomId();
    await this.db.execute("INSERT INTO recurring_rules (uuid, name, template, frequency, interval, start_on, end_on, next_on, auto_post, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [uuid, name, template, input.frequency, interval, input.startOn, input.endOn ?? null, input.startOn, input.autoPost ? 1 : 0, stamp, stamp]);
    const [row] = await this.db.select<Row>("SELECT id FROM recurring_rules WHERE uuid = ?", [uuid]);
    await this.audit({ actor, action: "create", subjectType: "recurring_rule", subjectId: uuid, summary: name });
    return Number(row.id);
  }

  async setRecurringPaused(id: number, paused: boolean, actor = "user"): Promise<void> {
    await this.db.execute("UPDATE recurring_rules SET paused = ?, updated_at = ? WHERE id = ?", [paused ? 1 : 0, now(), id]);
    await this.audit({ actor, action: paused ? "archive" : "unarchive", subjectType: "recurring_rule", subjectId: id });
  }

  /** Deletes a schedule. Entries it already created stay (they are ordinary entries). */
  async deleteRecurringRule(id: number, actor = "user"): Promise<void> {
    await this.db.execute("DELETE FROM recurring_rules WHERE id = ?", [id]);
    await this.audit({ actor, action: "delete", subjectType: "recurring_rule", subjectId: id });
  }

  /** Occurrences due up to `today` that have not been posted yet. */
  async dueOccurrences(today = new Date().toISOString().slice(0, 10)): Promise<Array<{ rule: RecurringRule; on: string }>> {
    const due: Array<{ rule: RecurringRule; on: string }> = [];
    for (const rule of await this.recurringRules()) {
      if (rule.paused || !rule.nextOn || rule.nextOn > today) continue;
      const until = rule.endOn && rule.endOn < today ? rule.endOn : today;
      for (const on of occurrences(rule.startOn, until, rule.frequency, rule.interval, 400).filter((date) => date >= rule.nextOn!)) due.push({ rule, on });
    }
    return due.sort((a, b) => a.on.localeCompare(b.on));
  }

  /** The next few dates of a schedule (preview in the form). */
  previewOccurrences(startOn: string, frequency: Frequency, interval = 1, count = 5, endOn: string | null = null): string[] {
    const out: string[] = [];
    let current = startOn;
    while (out.length < count && (!endOn || current <= endOn)) {
      out.push(current);
      current = nextOccurrence(startOn, current, frequency, interval);
    }
    return out;
  }

  /**
   * Posts due occurrences as entries (actor "recurring"). Idempotent: an occurrence already posted
   * (unique recurring_rule_id + recurring_on + account) is skipped. `onlyAuto` posts only schedules
   * the person set to post automatically. Returns how many entries were created.
   */
  async postDue(today = new Date().toISOString().slice(0, 10), options: { onlyAuto?: boolean; ruleIds?: number[] } = {}): Promise<number> {
    let posted = 0;
    const due = await this.dueOccurrences(today);
    for (const { rule, on } of due) {
      if (options.onlyAuto && !rule.autoPost) continue;
      if (options.ruleIds && !options.ruleIds.includes(rule.id)) continue;
      const exists = await this.db.select<Row>("SELECT 1 FROM transactions WHERE recurring_rule_id = ? AND recurring_on = ?", [rule.id, on]);
      if (exists.length === 0) {
        try {
          await this.createEntry({ ...rule.template, occurredOn: on, refundOf: undefined }, "recurring", "recurring", { ruleId: rule.id, on });
          posted += 1;
        } catch (error) {
          if (!(error instanceof LedgerError)) throw error;
          // A schedule whose account was deleted, for example: leave it due; the page shows it.
          continue;
        }
      }
      const next = nextOccurrence(rule.startOn, on, rule.frequency, rule.interval);
      await this.db.execute("UPDATE recurring_rules SET next_on = ?, updated_at = ? WHERE id = ?", [rule.endOn && next > rule.endOn ? null : next, now(), rule.id]);
    }
    return posted;
  }

  /** Skips the next due occurrence of a schedule without posting it. */
  async skipOccurrence(id: number): Promise<void> {
    const rule = (await this.recurringRules()).find((item) => item.id === id);
    if (!rule || !rule.nextOn) return;
    const next = nextOccurrence(rule.startOn, rule.nextOn, rule.frequency, rule.interval);
    await this.db.execute("UPDATE recurring_rules SET next_on = ?, updated_at = ? WHERE id = ?", [rule.endOn && next > rule.endOn ? null : next, now(), id]);
    await this.audit({ action: "update", subjectType: "recurring_rule", subjectId: id, summary: `skipped ${rule.nextOn}` });
  }

  // ------------------------------------------------------------------------------- review lists

  /** Rows counted as income that look like refunds or card repayments (P0-2 review list). */
  async suspectIncome(): Promise<Array<{ id: number; occurredOn: string; description: string; amountCents: number; accountName: string; suggested: TransactionKind }>> {
    const { suspectIncome } = await import("@billie/finance-core");
    const rows = await this.db.select<Row>(`SELECT t.id, t.booked_on, t.original_description, t.description, t.amount_cents, t.user_locked_fields, a.name AS account_name, a.account_type
      FROM transactions t LEFT JOIN accounts a ON a.id = t.account_id WHERE t.kind = 'income' AND t.deleted_at IS NULL ORDER BY t.booked_on DESC`);
    return rows.flatMap((row) => {
      if (parseLocked(row.user_locked_fields).includes("kind")) return [];
      const type = isAccountType(row.account_type) ? (row.account_type as AccountType) : null;
      const suggested = suspectIncome({ kind: "income", amountMinor: Number(row.amount_cents), accountType: type === "other" ? null : type, description: String(row.original_description ?? row.description) });
      return suggested ? [{ id: Number(row.id), occurredOn: String(row.booked_on), description: String(row.description), amountCents: Number(row.amount_cents), accountName: String(row.account_name ?? ""), suggested }] : [];
    });
  }

  /** Liability accounts (cards, loans) for forms that need them. */
  async liabilityAccounts(): Promise<Account[]> {
    return (await this.accounts()).filter((account) => isLiability(account.type));
  }
}
