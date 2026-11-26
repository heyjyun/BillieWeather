// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import initSqlJs from "sql.js";
import { migrate } from "./helpers";
import { sqljsDriver } from "../src/services/sqljsDriver";
import { FinanceProvider, useFinance } from "../src/hooks/useFinance";
import { I18nProvider } from "../src/i18n";

const files = new Map<string, ReturnType<typeof sqljsDriver>>();
let snapshotOwner = "id:alice";
vi.mock("../src/hooks/useAccount", () => {
  const getToken = () => null;
  const expire = async () => undefined;
  return { useAccount: () => ({ account: null, getToken, expire }) };
});
vi.mock("../src/services/platform", async () => {
  const SQL = await initSqlJs();
  const make = () => { const db = new SQL.Database(); migrate(db); return sqljsDriver(db); };
  return {
    isTauri: () => false,
    deviceName: async () => "Synthetic Mac", deviceIdentity: async () => null,
    openDatabase: async (file: string) => {
      if (!files.has(file)) {
        const driver = make();
        await driver.execute("INSERT INTO settings (key, value) VALUES ('database_name', 'Bob'), ('owner_account_id', 'id:bob')");
        files.set(file, driver);
      }
      return { driver: files.get(file)!, persistent: true };
    },
    restoreSnapshot: async (_name: string, slot: number) => {
      const file = `billieweather-${slot}.db`;
      if (files.has(file)) throw new Error("occupied");
      const driver = make();
      await driver.execute("INSERT INTO settings (key, value) VALUES ('database_name', 'Snapshot'), ('owner_account_id', ?), ('report_id', 'old-device-copy')", [snapshotOwner]);
      await driver.execute("INSERT INTO categories (name, kind, created_at, updated_at) VALUES ('Private category', 'expense', '2026-11-01', '2026-11-01')");
      files.set(file, driver);
    },
  };
});

let finance: ReturnType<typeof useFinance>;
function Probe() {
  finance = useFinance();
  return <p>Ready</p>;
}
beforeEach(() => { localStorage.clear(); files.clear(); snapshotOwner = "id:alice"; });
afterEach(() => cleanup());

it("never adopts another account's automatic snapshot", async () => {
  render(<I18nProvider><FinanceProvider ownerKey="id:bob"><Probe /></FinanceProvider></I18nProvider>);
  await screen.findByText("Ready");
  await act(async () => { await expect(finance.openSnapshot("billieweather.db.pre-v7-123.bak")).rejects.toThrow("another account"); });
  expect(finance.databaseIds).toEqual(["1"]);
  expect(await finance.store.owner()).toBe("id:bob");
  // The emptied copy is nobody's: nothing of the other account is left and the slot can be used again.
  const left = files.get("billieweather-2.db")!;
  expect(await left.select("SELECT value FROM settings WHERE key = 'owner_account_id'")).toEqual([]);
  expect(await left.select("SELECT name FROM custom_categories")).toEqual([]);
  expect((await finance.claimSlotForRestore())?.id).toBe("2");
});

it("gives an authorized snapshot copy a new metadata identity", async () => {
  snapshotOwner = "id:bob";
  render(<I18nProvider><FinanceProvider ownerKey="id:bob"><Probe /></FinanceProvider></I18nProvider>);
  await screen.findByText("Ready");
  await act(async () => { expect(await finance.openSnapshot("billieweather.db.pre-v7-123.bak")).toBe("2"); });
  const restored = await finance.openStore("2");
  expect(await restored.owner()).toBe("id:bob");
  expect(await restored.peekReportId()).toBeNull();
  expect(await restored.customCategories()).toEqual(["Private category"]);
});
