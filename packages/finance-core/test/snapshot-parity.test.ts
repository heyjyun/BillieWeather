// Imports every fixture statement and checks the dashboard totals against
// fixtures/expected/snapshot.json — the same file Rails checks in
// test/services/finance/shared_fixture_parity_test.rb.
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Statement, Transaction } from "@billie/shared-types";
import { buildSnapshot, Categorizer, parseStatement } from "../src";

const fixtures = join(__dirname, "../fixtures");

export function snapshotSummary() {
  const statements: Statement[] = [];
  const transactions: Transaction[] = [];
  readdirSync(join(fixtures, "statements")).filter((f) => f.endsWith(".csv")).sort().forEach((file, index) => {
    const parsed = parseStatement(readFileSync(join(fixtures, "statements", file), "utf8"), { filename: file, currency: "USD", categorizer: new Categorizer() });
    const id = index + 1;
    statements.push({ id, filename: file, currency: "USD", sha256: file, transactionCount: parsed.rows.length, closingBalanceCents: parsed.closingBalanceCents, closingBalanceOn: parsed.closingBalanceOn, importedAt: "" });
    parsed.rows.forEach((row) => transactions.push({ ...row, id: transactions.length + 1, statementId: id }));
  });
  const snap = buildSnapshot({ transactions, statements, period: { startDate: null, endDate: null }, currency: "USD" });
  return {
    incomeCents: snap.incomeCents, expensesCents: snap.expensesCents, netCents: snap.netCents,
    transactionCount: snap.transactionCount, statementCount: snap.statementCount, uncategorizedCount: snap.uncategorizedCount,
    taxReviewCount: snap.taxReviewCount, transferCount: snap.transferCount, periodStart: snap.periodStart, periodEnd: snap.periodEnd,
    categories: snap.categories.map((c) => ({ name: c.name, amountCents: c.amountCents })),
    monthly: snap.monthly,
  };
}

it("matches the shared expected dashboard totals", () => {
  const path = join(fixtures, "expected/snapshot.json");
  if (!existsSync(path)) writeFileSync(path, JSON.stringify(snapshotSummary(), null, 2) + "\n");
  expect(snapshotSummary()).toEqual(JSON.parse(readFileSync(path, "utf8")));
});
