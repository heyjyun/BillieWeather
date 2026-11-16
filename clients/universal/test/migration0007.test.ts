// Migration 0007 (hybrid ledger) on a synthetic version-6 database: it must be additive, reproduce
// every total exactly, backfill accounts/kinds/original text, and enforce the new invariants.
import initSqlJs, { type Database } from "sql.js";
import { buildSnapshot, totals, type LedgerEntry } from "@billie/finance-core";
import { migrate } from "./helpers";

const rows = (db: Database, sql: string, params: unknown[] = []) => {
  const statement = db.prepare(sql);
  statement.bind(params as never);
  const out: Array<Record<string, unknown>> = [];
  while (statement.step()) out.push(statement.getAsObject());
  statement.free();
  return out;
};

async function legacyDatabase(): Promise<Database> {
  const SQL = await initSqlJs();
  const db = new SQL.Database();
  db.exec("PRAGMA foreign_keys = ON");
  migrate(db, 6);
  const stamp = "2026-10-01T00:00:00.000Z";
  // A checking account statement with a closing balance, a card statement, a legacy file with no account, and a website copy.
  db.run(`INSERT INTO statements (id, filename, currency, sha256, transaction_count, closing_balance_cents, closing_balance_on, imported_at, account_key, institution, account_last4, account_kind)
          VALUES (1, 'chk.csv', 'USD', 'h1', 3, 150000, '2026-10-31', ?, 'zxq bank|1111|checking', 'ZXQ Bank', '1111', 'checking')`, [stamp]);
  db.run(`INSERT INTO statements (id, filename, currency, sha256, transaction_count, imported_at, account_key, institution, account_last4, account_kind)
          VALUES (2, 'card.csv', 'USD', 'h2', 3, ?, 'zxq bank|2222|credit_card', 'ZXQ Bank', '2222', 'credit_card')`, [stamp]);
  db.run(`INSERT INTO statements (id, filename, currency, sha256, transaction_count, imported_at) VALUES (3, 'legacy.csv', 'USD', 'h3', 1, ?)`, [stamp]);
  db.run(`INSERT INTO statements (id, filename, currency, sha256, transaction_count, imported_at, source, remote_id) VALUES (4, 'web.csv', 'USD', 'h4', 1, ?, 'web', 77)`, [stamp]);
  const tx = (id: number, statement: number, date: string, description: string, cents: number, category: string, extra = "") =>
    db.run(`INSERT INTO transactions (id, statement_id, booked_on, description, amount_cents, category, updated_at${extra ? ", remote_id" : ""}) VALUES (?, ?, ?, ?, ?, ?, ?${extra ? ", ?" : ""})`,
      [id, statement, date, description, cents, category, stamp, ...(extra ? [Number(extra)] : [])]);
  tx(1, 1, "2026-10-02", "ZXQ PAYROLL", 200000, "Income");
  tx(2, 1, "2026-10-05", "ONLINE TRANSFER TO CARD", -17000, "Transfers");
  tx(3, 1, "2026-11-03", "ZXQ CAFE", -500, "Food & dining");
  tx(4, 2, "2026-10-03", "ZXQ GROCERY", -12000, "Food & dining");
  tx(5, 2, "2026-10-15", "ZXQ OUTFITTERS RETURN", 3000, "Income");
  tx(6, 2, "2026-10-28", "PAYMENT THANK YOU", 17000, "Transfers");
  tx(7, 3, "2026-09-30", "ZXQ OLD SHOP", -4200, "Shopping");
  tx(8, 4, "2026-10-10", "ZXQ WEB ROW", -999, "Shopping", "501");
  db.run("UPDATE transactions SET account_key = 'zxq bank|1111|checking' WHERE statement_id = 1");
  return db;
}

describe("migration 0007 (hybrid ledger)", () => {
  it("reproduces every total exactly and backfills kinds, accounts and original descriptions", async () => {
    const db = await legacyDatabase();
    // Today's code needs version 7, so read the version-6 rows directly.
    const legacy = rows(db, "SELECT * FROM transactions").map((row) => ({ id: Number(row.id), statementId: Number(row.statement_id), bookedOn: String(row.booked_on), description: String(row.description),
      amountCents: Number(row.amount_cents), category: String(row.category), taxReview: false, excluded: Number(row.excluded) === 1 }));
    const before = buildSnapshot({ transactions: legacy, statements: [], period: { startDate: null, endDate: null }, currency: "USD" });
    const countBefore = rows(db, "SELECT COUNT(*) AS n, SUM(amount_cents) AS s FROM transactions")[0];

    migrate(db);

    const countAfter = rows(db, "SELECT COUNT(*) AS n, SUM(amount_cents) AS s FROM transactions")[0];
    expect(countAfter).toEqual(countBefore);
    const entries = rows(db, "SELECT id, account_id, booked_on, amount_cents, kind, category, excluded FROM transactions").map((row): LedgerEntry => ({
      id: Number(row.id), accountId: Number(row.account_id), occurredOn: String(row.booked_on), amountMinor: Number(row.amount_cents),
      kind: row.kind as LedgerEntry["kind"], category: String(row.category), excluded: Number(row.excluded) === 1,
    }));
    const after = totals(entries);
    // The backfill is the legacy rule, so the kind-based totals equal the old sign-based ones.
    expect([after.incomeMinor, after.expenseMinor]).toEqual([before.incomeCents, before.expensesCents]);
    expect(rows(db, "SELECT id, kind FROM transactions ORDER BY id").map((row) => row.kind)).toEqual(["income", "transfer", "expense", "expense", "income", "transfer", "expense", "expense"]);
    expect(rows(db, "SELECT COUNT(*) AS n FROM transactions WHERE original_description = description AND uuid IS NOT NULL")[0].n).toBe(8);
    expect(rows(db, "SELECT COUNT(DISTINCT uuid) AS n FROM transactions")[0].n).toBe(8);
    expect(rows(db, "SELECT entry_origin FROM transactions WHERE id = 8")[0].entry_origin).toBe("web_copy");

    const accounts = rows(db, "SELECT name, account_type, account_key, opening_balance_cents, opening_balance_source FROM accounts ORDER BY id");
    expect(accounts).toEqual([
      // closing 1500.00 on 10-31 = opening + 2000.00 - 170.00 (the 11-03 row is after the closing date)
      { name: "ZXQ Bank …1111", account_type: "checking", account_key: "zxq bank|1111|checking", opening_balance_cents: 150000 - 200000 + 17000, opening_balance_source: "statement" },
      { name: "ZXQ Bank …2222", account_type: "credit_card", account_key: "zxq bank|2222|credit_card", opening_balance_cents: 0, opening_balance_source: "unknown" },
      { name: "Imported (no account)", account_type: "other", account_key: "__unassigned__", opening_balance_cents: 0, opening_balance_source: "unknown" },
    ]);
    expect(rows(db, "SELECT COUNT(*) AS n FROM transactions WHERE account_id IS NULL")[0].n).toBe(0);
    expect(rows(db, "SELECT COUNT(*) AS n FROM statements WHERE account_id IS NULL")[0].n).toBe(0);
    expect(rows(db, "SELECT a.account_key FROM transactions t JOIN accounts a ON a.id = t.account_id WHERE t.id IN (7, 8) ORDER BY t.id").map((r) => r.account_key)).toEqual(["__unassigned__", "__unassigned__"]);
  });

  it("keeps the bank's original text immutable while the display text stays editable", async () => {
    const db = await legacyDatabase();
    migrate(db);
    db.run("UPDATE transactions SET description = 'Dinner with Sam' WHERE id = 3");
    expect(() => db.run("UPDATE transactions SET original_description = 'tampered' WHERE id = 3")).toThrow(/original_description_immutable/);
    expect(rows(db, "SELECT description, original_description FROM transactions WHERE id = 3")[0]).toEqual({ description: "Dinner with Sam", original_description: "ZXQ CAFE" });
  });

  it("fills identity on every insert path, including the import trigger", async () => {
    const db = await legacyDatabase();
    migrate(db);
    db.run(`INSERT INTO transactions (statement_id, booked_on, description, amount_cents, category, updated_at) VALUES (1, '2026-11-05', 'ZXQ NEW', -100, 'Shopping', 'x')`);
    const [row] = rows(db, "SELECT uuid, original_description, kind FROM transactions WHERE description = 'ZXQ NEW'");
    expect(String(row.uuid)).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(row.original_description).toBe("ZXQ NEW");
  });

  it("writes a transfer's two legs and its link in one statement, or nothing", async () => {
    const db = await legacyDatabase();
    migrate(db);
    db.run(`INSERT INTO transactions (statement_id, account_id, booked_on, description, amount_cents, category, kind, entry_origin, link_group, link_hint, updated_at)
            VALUES (1, 1, '2026-11-06', 'To card', -5000, 'Transfers', 'card_payment', 'manual', 'g1', NULL, 'x'),
                   (1, 2, '2026-11-06', 'From checking', 5000, 'Transfers', 'card_payment', 'manual', 'g1', 'card_payment', 'x')`);
    const [link] = rows(db, "SELECT link_type, amount_cents, status FROM transaction_links");
    expect(link).toEqual({ link_type: "card_payment", amount_cents: 5000, status: "confirmed" });
    const count = Number(rows(db, "SELECT COUNT(*) AS n FROM transactions")[0].n);
    // An inflow leg without its outflow leg aborts the whole INSERT.
    expect(() => db.run(`INSERT INTO transactions (statement_id, account_id, booked_on, description, amount_cents, category, kind, link_group, updated_at)
            VALUES (1, 2, '2026-11-07', 'orphan', 700, 'Transfers', 'transfer', 'g2', 'x')`)).toThrow(/transfer_leg_missing/);
    expect(Number(rows(db, "SELECT COUNT(*) AS n FROM transactions")[0].n)).toBe(count);
  });

  it("links refunds to their expense and refuses refunds beyond it", async () => {
    const db = await legacyDatabase();
    migrate(db);
    const refund = (cents: number) => db.run(`INSERT INTO transactions (statement_id, account_id, booked_on, description, amount_cents, category, kind, link_hint, link_target_id, updated_at)
      VALUES (2, 2, '2026-10-20', 'refund', ?, 'Food & dining', 'refund', 'refund_of', 4, 'x')`, [cents]);
    refund(5000);
    refund(7000);
    expect(() => refund(1)).toThrow(/refund_too_large/);
    expect(rows(db, "SELECT SUM(amount_cents) AS s FROM transaction_links WHERE link_type = 'refund_of' AND to_transaction_id = 4")[0].s).toBe(12000);
    expect(() => db.run(`INSERT INTO transactions (statement_id, account_id, booked_on, description, amount_cents, category, kind, link_hint, link_target_id, updated_at)
      VALUES (2, 2, '2026-10-20', 'refund of income?', 10, 'Income', 'refund', 'refund_of', 1, 'x')`)).toThrow(/refund_target_invalid/);
  });

  it("keeps the operation log append-only", async () => {
    const db = await legacyDatabase();
    migrate(db);
    db.run("INSERT INTO audit_events (uuid, at, actor, action, subject_type) VALUES ('u1', 'x', 'user', 'create', 'transaction')");
    expect(() => db.run("UPDATE audit_events SET action = 'delete'")).toThrow(/append_only/);
    expect(() => db.run("DELETE FROM audit_events")).toThrow(/append_only/);
    db.run("INSERT INTO settings (key, value) VALUES ('audit_purge', '1')");
    db.run("DELETE FROM audit_events");
    expect(rows(db, "SELECT COUNT(*) AS n FROM audit_events")[0].n).toBe(0);
  });

  it("an import after the migration stores kind, account and original text through the commit trigger", async () => {
    const db = await legacyDatabase();
    migrate(db);
    db.run(`INSERT INTO import_staging_rows (staging_key, position, booked_on, description, amount_cents, category, tax_review, currency, direction, category_source, pending, validation_status, staged_at, kind, account_id)
            VALUES ('h9', 0, '2026-11-08', 'ZXQ STORE REFUND', 2500, 'Shopping', 0, 'USD', 'credit', 'auto', 0, 'valid', 'x', 'refund', 2)`);
    db.run(`INSERT INTO statements (filename, currency, sha256, transaction_count, imported_at, import_batch_id, account_id) VALUES ('n.csv', 'USD', 'h9', 1, 'x', 'b9', 2)`);
    expect(rows(db, "SELECT kind, account_id, original_description, entry_origin FROM transactions WHERE description = 'ZXQ STORE REFUND'")[0])
      .toEqual({ kind: "refund", account_id: 2, original_description: "ZXQ STORE REFUND", entry_origin: "import" });
  });
});
