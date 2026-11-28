// @vitest-environment jsdom
// Signing in to the browser preview right after its database is built (2026-11-28: the dev server
// served migrations 1–10 to code that needs 11, and the first read after sign-in failed with "no such
// table: categories"). The provider must only read the database once every migration has run, and a
// stale migration list must be explained instead of surfacing as a missing table. Synthetic data only.
import { cleanup, render, screen } from "@testing-library/react";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import initSqlJs from "sql.js";
import { MIGRATIONS_DIR } from "./helpers";
import { LOCAL_SCHEMA_VERSION } from "../src/services/backup";
import { openPreviewDatabase } from "../src/services/browserDatabase";
import { migrationVersions } from "../src/services/migrations";
import { sqljsDriver } from "../src/services/sqljsDriver";
import { FinanceProvider, useFinance } from "../src/hooks/useFinance";
import { I18nProvider, MESSAGES } from "../src/i18n";

const latest = String(LOCAL_SCHEMA_VERSION).padStart(4, "0");
const all = Object.fromEntries(readdirSync(MIGRATIONS_DIR).filter((name) => name.endsWith(".sql"))
  .map((name) => [`../../src-tauri/migrations/${name}`, readFileSync(join(MIGRATIONS_DIR, name), "utf8")]));
let served: Record<string, string> = all;
// The platform.ts browser branch before 2026-11-28: run whatever was served, check nothing.
let legacy = false;

vi.mock("../src/hooks/useAccount", () => {
  const getToken = () => null;
  const expire = async () => undefined;
  const account = { email: "zxq@example.test" };
  return { useAccount: () => ({ account, getToken, expire }) };
});
// platform.ts's browser branch on a dev server, with the migration list the page was given.
vi.mock("../src/services/platform", async () => {
  const SQL = await initSqlJs();
  return {
    isTauri: () => false,
    deviceName: async () => "Synthetic Mac",
    deviceIdentity: async () => null,
    openDatabase: async () => {
      // The dev server's reading of the folder is always the full set; the page may have been given less.
      if (!legacy) return { driver: sqljsDriver(await openPreviewDatabase(SQL, served, migrationVersions(all))), persistent: false };
      const db = new SQL.Database();
      for (const path of Object.keys(served).sort()) db.exec(served[path]);
      return { driver: sqljsDriver(db), persistent: false };
    },
  };
});

function Probe() {
  const finance = useFinance();
  return <p>Ready {finance.categories.length}</p>;
}
const signIn = () => render(<I18nProvider initial="en"><FinanceProvider ownerKey="id:zxq" emailKey="email:zxq"><Probe /></FinanceProvider></I18nProvider>);

afterEach(() => {
  cleanup();
  localStorage.clear();
  served = all;
  legacy = false;
});

describe("signing in to the browser preview", () => {
  it("reads the category tree as soon as the database is built", async () => {
    signIn();
    expect(await screen.findByText("Ready 84", undefined, { timeout: 5000 })).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("reproduces the original failure with the old, unchecked browser branch", async () => {
    served = Object.fromEntries(Object.entries(all).filter(([path]) => Number(path.split("/").at(-1)!.slice(0,4)) <= 10));
    legacy = true;
    signIn();
    expect((await screen.findByRole("alert", undefined, { timeout: 5000 })).textContent).toMatch(/no such table: categories/);
  });

  it("explains a stale dev server instead of failing with 'no such table: categories'", async () => {
    served = Object.fromEntries(Object.entries(all).filter(([path]) => !path.includes(`/${latest}_`)));
    signIn();
    const alert = await screen.findByRole("alert", undefined, { timeout: 5000 });
    expect(alert.textContent).toContain(MESSAGES.en.boot.failure.previewStale);
    expect(alert.textContent).toMatch(/browser preview migrations are out of date/);
    expect(alert.textContent).not.toMatch(/no such table/);
  });
});
