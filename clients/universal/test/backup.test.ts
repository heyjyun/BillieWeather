// P0-5: local backup and restore on synthetic databases (never the real backups folder).
import initSqlJs from "sql.js";
import { migrate, newStore, fixtureBytes } from "./helpers";
import { sqljsDriver } from "../src/services/sqljsDriver";
import { FinanceStore } from "../src/services/store";
import { BackupError, backupFileName, createBackup, isEncryptedBackup, manifestOf, readBackup, restoreInto, serializeBackup } from "../src/services/backup";
import { importFile } from "../src/services/importFile";

async function populated() {
  const { store, db } = await newStore();
  const driver = sqljsDriver(db);
  await store.setDatabaseName("ZXQ Household");
  await store.setOwner("id:00000000-0000-4000-8000-000000000001");
  await importFile(store, fixtureBytes("basic-amount.csv"), "basic-amount.csv", "USD");
  const L = store.ledger;
  const chk = await L.createAccount({ name: "ZXQ Checking", type: "checking", openingBalanceCents: 100000 });
  const card = await L.createAccount({ name: "ZXQ Card", type: "credit_card" });
  const [expense] = await L.createEntry({ kind: "expense", amountCents: 8000, occurredOn: "2026-10-09", accountId: card.id, category: "Shopping", merchant: "ZXQ Outfitters", tags: ["gift"] });
  await L.createEntry({ kind: "refund", amountCents: 3000, occurredOn: "2026-10-15", accountId: card.id, category: "Shopping", refundOf: expense });
  await L.createEntry({ kind: "transfer", amountCents: 5000, occurredOn: "2026-10-28", accountId: chk.id, toAccountId: card.id });
  const [trashed] = await L.createEntry({ kind: "expense", amountCents: 1234, occurredOn: "2026-10-29", accountId: chk.id });
  await L.deleteEntries([trashed]);
  await store.addCategory("Coffee");
  await L.setCategoryMeta("Coffee", { parent: "Food & dining" }, await store.customCategories());
  await L.saveBudget({ period: "month", category: "Shopping", amountCents: 20000 });
  await L.saveRecurringRule({ name: "Rent", template: { kind: "expense", amountCents: 100000, accountId: chk.id, category: "Housing" }, frequency: "monthly", startOn: "2026-11-01" });
  await store.reportId();
  return { store, driver };
}

async function emptyDatabase() {
  const SQL = await initSqlJs();
  const db = new SQL.Database();
  migrate(db);
  return { store: new FinanceStore(sqljsDriver(db)), driver: sqljsDriver(db), db };
}

describe("local backup and restore", () => {
  it("restores everything into a new database: rows, links, trash, balances, net worth, categories, budgets, schedules", async () => {
    const { store, driver } = await populated();
    const backup = await readBackup(await serializeBackup(await createBackup(driver)));
    expect(backup.book.name).toBe("ZXQ Household");
    const target = await emptyDatabase();
    const restored = await restoreInto(target.driver, backup, { owner: "id:00000000-0000-4000-8000-000000000001", name: "ZXQ Household (restored)" });
    expect(restored).toEqual(await manifestOf(driver));
    const strip = (rows: unknown[]) => JSON.stringify(rows);
    expect(strip(await target.store.transactions())).toBe(strip(await store.transactions()));
    expect(strip(await target.store.ledger.accounts({ includeArchived: true }))).toBe(strip(await store.ledger.accounts({ includeArchived: true })));
    expect(await target.store.ledger.netWorth()).toEqual(await store.ledger.netWorth());
    expect((await target.store.ledger.trash()).length).toBe(1);
    expect(strip(await target.store.ledger.categoryTree(await target.store.customCategories()))).toBe(strip(await store.ledger.categoryTree(await store.customCategories())));
    expect((await target.store.ledger.budgets("2026-10-20")).map((b) => b.status.spentMinor)).toEqual([5000]);
    expect((await target.store.ledger.recurringRules()).map((r) => r.name)).toEqual(["Rent"]);
    expect(await target.store.statements()).toHaveLength(1);
    // Device identity is not copied: the restored copy gets its own metadata card id.
    expect(await target.store.peekReportId()).toBeNull();
    expect(await target.store.databaseName()).toBe("ZXQ Household (restored)");
    expect((await target.store.ledger.auditEvents({ limit: 1 }))[0].action).toBe("restore_backup");
    // The restored copy keeps working: links and the import trigger.
    const card = (await target.store.ledger.accounts()).find((a) => a.name === "ZXQ Card")!;
    await target.store.ledger.createEntry({ kind: "transfer", amountCents: 100, occurredOn: "2026-11-01", accountId: card.id - 1, toAccountId: card.id });
    await importFile(target.store, fixtureBytes("type-category-symbols.csv"), "t.csv", "USD");
  });

  it("encrypts with a passphrase and refuses a wrong one", async () => {
    const { driver } = await populated();
    const bytes = await serializeBackup(await createBackup(driver), "correct horse battery");
    expect(isEncryptedBackup(bytes)).toBe(true);
    expect(new TextDecoder().decode(bytes)).not.toContain("Household");
    await expect(readBackup(bytes)).rejects.toMatchObject({ code: "passphrase_required" });
    await expect(readBackup(bytes, "wrong")).rejects.toMatchObject({ code: "wrong_passphrase" });
    expect((await readBackup(bytes, "correct horse battery")).book.name).toBe("ZXQ Household");
  });

  it("detects tampering and files that are not backups", async () => {
    const { driver } = await populated();
    const content = await createBackup(driver);
    content.tables.transactions.rows[0][4] = 1;
    await expect(readBackup(new TextEncoder().encode(JSON.stringify(content)))).rejects.toMatchObject({ code: "damaged" });
    await expect(readBackup(new TextEncoder().encode("Date,Description\n"))).rejects.toMatchObject({ code: "not_a_backup" });
    await expect(readBackup(new TextEncoder().encode(JSON.stringify({ ...content, schemaVersion: 99 })))).rejects.toMatchObject({ code: "newer_version" });
  });

  it("never restores over a database that holds data, and rolls back a restore that does not verify", async () => {
    const { driver, store } = await populated();
    const backup = await createBackup(driver);
    await expect(restoreInto(driver, backup)).rejects.toMatchObject({ code: "target_not_empty" });
    expect((await store.transactions()).length).toBeGreaterThan(0);
    const target = await emptyDatabase();
    const wrong = { ...backup, manifest: { ...backup.manifest, transactionsAmountCents: backup.manifest.transactionsAmountCents + 1 } };
    await expect(restoreInto(target.driver, wrong)).rejects.toBeInstanceOf(BackupError);
    expect(await target.store.transactions()).toEqual([]);
    expect(await target.store.ledger.accounts({ includeArchived: true })).toEqual([]);
    expect(await target.store.hasContent()).toBe(false);
  });

  it("names backup files safely", () => {
    expect(backupFileName("ZXQ Household / 2026", new Date("2026-11-15T00:00:00Z"))).toBe("billieweather-backup-ZXQ-Household-2026-2026-11-15.bwbackup");
    expect(backupFileName(null, new Date("2026-11-15T00:00:00Z"))).toBe("billieweather-backup-book-2026-11-15.bwbackup");
  });

  it("refuses a target holding only custom categories and preserves that data on failure", async () => {
    const backup = await createBackup((await populated()).driver);
    const target = await emptyDatabase();
    await target.store.addCategory("Existing category");
    expect(await target.store.hasContent()).toBe(true);
    await expect(restoreInto(target.driver, backup)).rejects.toMatchObject({ code: "target_not_empty" });
    expect(await target.store.customCategories()).toEqual(["Existing category"]);
  });

  it("rejects malformed JSON documents and never silently drops orphaned financial rows", async () => {
    for (const invalid of [null, [], { format: "billieweather-backup", version: 1, tables: {}, manifest: {} }]) {
      await expect(readBackup(new TextEncoder().encode(JSON.stringify(invalid)))).rejects.toBeInstanceOf(BackupError);
    }
    const backup = await createBackup((await populated()).driver);
    const index = backup.tables.transactions.columns.indexOf("account_id");
    backup.tables.transactions.rows[0][index] = 999999;
    backup.checksum = [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(backup.tables))))].map((byte) => byte.toString(16).padStart(2, "0")).join("");
    const target = await emptyDatabase();
    await expect(restoreInto(target.driver, backup)).rejects.toMatchObject({ code: "verify_failed" });
    expect(await target.store.transactions()).toEqual([]);
  });

  it("checks integrity at the restore boundary, including callers that bypass readBackup", async () => {
    const backup = await createBackup((await populated()).driver);
    backup.tables.transactions.rows[0][backup.tables.transactions.columns.indexOf("description")] = "changed";
    const target = await emptyDatabase();
    await expect(restoreInto(target.driver, backup)).rejects.toMatchObject({ code: "damaged" });
    expect(await target.store.hasContent()).toBe(false);
  });
  it("rejects fractional cents even when their sum and checksum are valid", async () => {
    const backup = await createBackup((await populated()).driver);
    const data = backup.tables.transactions;
    const index = data.columns.indexOf("amount_cents");
    data.rows[0][index] = 1.5;
    data.rows[1][index] = 2.5;
    backup.manifest.transactionsAmountCents = data.rows.reduce((sum, row) => sum + Number(row[index]), 0);
    backup.checksum = [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(backup.tables))))].map((byte) => byte.toString(16).padStart(2, "0")).join("");
    const target = await emptyDatabase();
    await expect(restoreInto(target.driver, backup)).rejects.toMatchObject({ code: "damaged" });
    expect(await target.store.hasContent()).toBe(false);
  });

  it("excludes device settings by column name when a backup reorders its columns", async () => {
    const backup = await createBackup((await populated()).driver);
    const settings = backup.tables.settings;
    settings.rows.push(["report_id", "source-device-identity"]);
    settings.columns.reverse();
    settings.rows = settings.rows.map((row) => [...row].reverse());
    backup.manifest.rows.settings = settings.rows.length;
    backup.checksum = [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(backup.tables))))].map((byte) => byte.toString(16).padStart(2, "0")).join("");
    const target = await emptyDatabase();
    await restoreInto(target.driver, backup, { owner: "id:new-owner" });
    expect(await target.store.peekReportId()).toBeNull();
    expect(await target.store.owner()).toBe("id:new-owner");
  });

});
