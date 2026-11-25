// The SQL the app sends for recorded edits, undo and redo, kept as a fixture that the Rust tests run on the
// app's own SQLite through its own transaction command (src-tauri/src/history_tests.rs). Synthetic data only.
// After an intended change: BILLIE_UPDATE_FIXTURES=1 npx vitest run test/historyNative.test.ts
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import initSqlJs from "sql.js";
import { migrate } from "./helpers";
import { importFile } from "../src/services/importFile";
import { recordedStore } from "../src/services/history/recorded";
import { sqljsDriver } from "../src/services/sqljsDriver";
import { FinanceStore, type SqlDriver, type SqlStatement } from "../src/services/store";

const FIXTURE = join(__dirname, "../src-tauri/tests/fixtures/history.json");
/** `statements` are [index into `sql`, params]; an undo or redo step names its group, which takes the place of GROUP in `replay`. */
type Step = { name: string; kind: "edit" | "undo" | "redo" | "outside" | "refused"; group?: number; statements?: Array<[number, unknown[]]> };
interface Fixture { sql: string[]; replay: Record<"undo" | "redo", Array<[string, unknown[]]>>; steps: Step[] }
const GROUP = 987654321;

async function record(): Promise<Fixture> {
  const { replayStatements } = await import("../src/services/history/history");
  const sql: string[] = [];
  const template = (direction: "undo" | "redo") => replayStatements(GROUP, direction).map((item): [string, unknown[]] => [item.sql, item.params ?? []]);
  const SQL = await initSqlJs();
  const db = new SQL.Database();
  migrate(db);
  db.run("PRAGMA foreign_keys = ON");
  const inner = sqljsDriver(db);
  const steps: Step[] = [];
  let name = "";
  let kind: Step["kind"] = "edit";
  let group: number | null = null;
  const log = (statements: readonly SqlStatement[]) => {
    if (group !== null) {
      // The replay itself (its operation-log entry aside) is exactly the template with the group's number.
      const direction = kind as "undo" | "redo";
      expect(statements.slice(0, -1).map((item) => item.sql)).toEqual(template(direction).map(([text]) => text.replaceAll(String(GROUP), String(group))));
      steps.push({ name, kind, group });
      return;
    }
    steps.push({ name, kind, statements: statements.map((item) => {
      if (!sql.includes(item.sql)) sql.push(item.sql);
      return [sql.indexOf(item.sql), item.params ?? []];
    }) });
  };
  const driver: SqlDriver = {
    select: inner.select, snapshot: inner.snapshot,
    execute: (sql, params) => { log([{ sql, params }]); return inner.execute(sql, params); },
    transaction: (statements) => { log(statements); return inner.transaction(statements); },
  };
  const store = recordedStore(new FinanceStore(driver));
  const L = store.ledger;
  const edit = async <T>(label: string, run: () => Promise<T>) => { name = label; kind = "edit"; return run(); };
  await edit("currency", () => L.setBookCurrency("USD"));
  const chk = await edit("account", () => L.createAccount({ name: "ZXQ Checking", type: "checking" }));
  const card = await edit("card", () => L.createAccount({ name: "ZXQ Card", type: "credit_card" }));
  await edit("import", () => importFile(store, new TextEncoder().encode(`Date,Description,Amount\n${Array.from({ length: 60 }, (_, i) => `2026-10-${String(1 + (i % 28)).padStart(2, "0")},ZXQ 商店 “${i}”,-${i + 1}.05`).join("\n")}\n`), "s.csv", "USD"));
  const [lunch] = await edit("create", () => L.createEntry({ kind: "expense", amountCents: 1234, occurredOn: "2026-10-05", accountId: chk.id, category: "Food & dining", description: "ZXQ LUNCH", merchant: "ZXQ Cafe", tags: ["work"] }));
  await edit("transfer", () => L.createEntry({ kind: "card_payment", amountCents: 5000, occurredOn: "2026-10-06", accountId: chk.id, toAccountId: card.id }));
  const [shoes] = await edit("expense", () => L.createEntry({ kind: "expense", amountCents: 8000, occurredOn: "2026-10-07", accountId: card.id, category: "Shopping", description: "ZXQ SHOES" }));
  const [refund] = await edit("refund", () => L.createEntry({ kind: "refund", amountCents: 3000, occurredOn: "2026-10-12", accountId: card.id, refundOf: shoes }));
  await edit("refund edit", () => L.updateEntry(refund, { kind: "refund", amountCents: 4000, occurredOn: "2026-10-12", accountId: card.id }));
  await edit("amount, date, tags", () => L.updateEntry(lunch, { kind: "expense", amountCents: 99_99, occurredOn: "2026-09-30", accountId: card.id, category: "Health", merchant: "Other", tags: ["new"], note: "quote ' \" \u0007 二" }));
  await edit("batch", () => L.batchUpdate([lunch, shoes], { category: "Transport", addTags: ["batch"] }));
  await edit("delete", () => L.deleteEntries([shoes, refund]));
  await edit("import undone", async () => store.reverseImport([(await store.statements())[0].id]));
  const step = async (direction: "undo" | "redo") => {
    const entry = (await store.history.state())[direction];
    if (!entry) return false;
    name = entry.action; kind = direction; group = entry.id;
    const outcome = await store.history.step(direction, entry.id);
    group = null;
    return outcome === "done";
  };
  for (let round = 0; round < 2; round += 1) {
    while (await step("undo"));
    while (await step("redo"));
  }
  expect((await store.history.state()).undo?.action).toBe("reverse_import");
  // Something else changes the entry: the undo of its edit must be refused by the database itself.
  await step("undo"); await step("undo"); await step("undo");
  name = "outside"; kind = "outside";
  await driver.execute("UPDATE transactions SET note = 'outside' WHERE id = ?", [lunch]);
  steps.push({ name: "refused", kind: "refused", group: (await store.history.state()).undo!.id });
  return { sql, replay: { undo: template("undo"), redo: template("redo") }, steps };
}

it("the fixture the native tests run is what the app sends today", async () => {
  const made = await record();
  if (process.env.BILLIE_UPDATE_FIXTURES) writeFileSync(FIXTURE, `${JSON.stringify(made)}\n`);
  const saved = JSON.parse(readFileSync(FIXTURE, "utf8")) as Fixture;
  // Everything but the values (random ids, times).
  const shape = (item: Fixture) => [item.sql, item.replay.undo.map(([text]) => text), item.replay.redo.map(([text]) => text),
    item.steps.map((step) => [step.name, step.kind, step.group ?? null, (step.statements ?? []).map(([at, params]) => [at, params.length])])];
  expect(shape(saved)).toEqual(shape(made));
});
