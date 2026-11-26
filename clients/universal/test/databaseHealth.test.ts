// Settings › Database › Check integrity (services/databaseHealth.ts): read-only, honest results.
import { checkDatabase } from "../src/services/databaseHealth";
import { importFile } from "../src/services/importFile";
import { fixtureBytes, newStore } from "./helpers";

async function bookWithData() {
  const { db, store } = await newStore();
  await importFile(store, fixtureBytes("basic-amount.csv"), "basic-amount.csv", "USD");
  return { db, store };
}

describe("database integrity check", () => {
  it("finds nothing wrong in a healthy database and changes nothing", async () => {
    const { db, store } = await bookWithData();
    const before = db.export();
    expect(await checkDatabase(store.sql)).toEqual({ ok: true, problems: 0, details: [] });
    expect(db.export()).toEqual(before);
  });

  it("reports rows whose links are broken", async () => {
    const { db, store } = await bookWithData();
    db.run("PRAGMA foreign_keys = OFF");
    db.run("DELETE FROM statements");
    const result = await checkDatabase(store.sql);
    expect(result.ok).toBe(false);
    expect(result.problems).toBeGreaterThan(0);
    expect(result.details.join(" ")).toMatch(/foreign_key_check/);
  });
});
