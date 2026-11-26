// @vitest-environment jsdom
// Undo and Redo on screen: the buttons name the edit, shortcuts work outside text fields, large steps ask first.
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import initSqlJs, { type Database } from "sql.js";
import { migrate, openInShell, showAllModulesInSidebar } from "./helpers";
import { shortcutFor } from "../src/components/HistoryControls";
import { sqljsDriver } from "../src/services/sqljsDriver";

const ROWS = 30;
const books = new Map<string, { db: Database; driver: ReturnType<typeof sqljsDriver> }>();
vi.mock("../src/services/platform", async () => {
  const SQL = await initSqlJs();
  return {
    isTauri: () => false,
    openDatabase: async (file = "billieweather.db") => {
      if (!books.has(file)) {
        const db = new SQL.Database();
        migrate(db);
        db.run("PRAGMA foreign_keys = ON");
        db.run("INSERT INTO settings (key, value) VALUES ('owner_account_id', 'id:12345678-1234-4123-8123-123456789abc'), ('database_name', 'Book'), ('currency', 'USD')");
        db.run("INSERT INTO accounts (id, uuid, name, account_type, currency, created_at, updated_at) VALUES (1, 'a', 'Checking', 'checking', 'USD', 'x', 'x')");
        db.run("INSERT INTO statements (id, filename, currency, sha256, transaction_count, imported_at, account_id) VALUES (1, 's.csv', 'USD', 's', ?, '2026-10-01', 1)", [ROWS]);
        for (let i = 1; i <= ROWS; i++) db.run("INSERT INTO transactions (statement_id, booked_on, description, amount_cents, category, updated_at, account_id) VALUES (1, '2026-10-01', ?, -100, 'Shopping', 'x', 1)", [`ROW ${String(i).padStart(2, "0")}`]);
        books.set(file, { db, driver: sqljsDriver(db) });
      }
      return { driver: books.get(file)!.driver, persistent: true };
    },
    deviceName: async () => "Mac", deviceIdentity: async () => null, saveFile: async () => true, listSnapshots: async () => [],
  };
});
const { default: App } = await import("../src/App");

beforeEach(() => {
  showAllModulesInSidebar(); localStorage.clear(); sessionStorage.clear(); books.clear();
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => String(input).endsWith("/account")
    ? new Response(JSON.stringify({ account: { email: "m@example.com", nickname: null, locale: "en", time_zone: null, usage_region: "US", registered_at: null, badges: [], owner_id: "12345678-1234-4123-8123-123456789abc" } }), { status: 200 })
    : new Response(JSON.stringify({ currency: null, version: "0", statement_count: 0, transaction_count: 0, statements: [], transactions: [], next_after_id: null, rules: [], categories: [] }), { status: 200 }));
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const value = (sql: string) => books.get("billieweather.db")!.db.exec(sql)[0]?.values[0][0];
const control = (direction: "undo" | "redo") => document.querySelector<HTMLButtonElement>(`[data-history="${direction}"]`)!;
const press = (target: Element, init: KeyboardEventInit) => act(async () => { fireEvent.keyDown(target, { bubbles: true, ctrlKey: true, ...init }); });

async function openList() {
  sessionStorage.setItem("billie.token", "tok");
  render(<App />);
  await screen.findByRole("navigation");
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Manual Accounting" })); });
  await openInShell("All Transactions");
  await screen.findByText("ROW 07");
}
/** Deletes one row through its own button. */
async function deleteRow(text: string) {
  const row = screen.getByText(text).closest("li")!;
  await act(async () => { fireEvent.click([...row.querySelectorAll("button")].find((button) => button.textContent === "Delete")!); });
  await waitFor(() => expect(screen.queryByText(text)).toBeNull());
}

it("names the edit, undoes it, redoes it and reports both", async () => {
  await openList();
  expect(control("undo").getAttribute("aria-disabled")).toBe("true");
  expect(control("undo").getAttribute("aria-label")).toBe("Nothing to undo");
  await deleteRow("ROW 07");
  await waitFor(() => expect(control("undo").getAttribute("aria-label")).toBe("Undo: move to trash “ROW 07”"));
  await act(async () => { fireEvent.click(control("undo")); });
  await screen.findByText("ROW 07");
  await screen.findByText("Undone: move to trash “ROW 07”.");
  expect(control("undo").getAttribute("aria-disabled")).toBe("true");
  expect(control("redo").getAttribute("aria-label")).toBe("Redo: move to trash “ROW 07”");
  await act(async () => { fireEvent.click(control("redo")); });
  await waitFor(() => expect(screen.queryByText("ROW 07")).toBeNull());
  expect(value("SELECT COUNT(*) FROM transactions WHERE deleted_at IS NOT NULL")).toBe(1);
});

it("uses the platform's shortcuts, except while typing or while a question is open", async () => {
  await openList();
  await deleteRow("ROW 07");
  await waitFor(() => expect(control("undo").getAttribute("aria-disabled")).toBe("false"));
  const search = document.querySelector<HTMLInputElement>('input[type="search"]')!;
  await press(search, { key: "z" });
  expect(value("SELECT COUNT(*) FROM transactions WHERE deleted_at IS NOT NULL")).toBe(1);
  const question = Object.assign(document.createElement("div"), { role: "alertdialog" });
  question.setAttribute("role", "alertdialog");
  document.body.append(question);
  await press(document.body, { key: "z" });
  expect(value("SELECT COUNT(*) FROM transactions WHERE deleted_at IS NOT NULL")).toBe(1);
  question.remove();
  // A category list is no text field: after choosing there, the shortcut undoes the choice.
  await press(document.querySelector("select")!, { key: "z" });
  await screen.findByText("ROW 07");
  await press(document.body, { key: "y" });
  await waitFor(() => expect(screen.queryByText("ROW 07")).toBeNull());
  await press(document.body, { key: "Z", shiftKey: true });
  expect(value("SELECT COUNT(*) FROM transactions WHERE deleted_at IS NOT NULL")).toBe(1);
});

it("maps keys per platform", () => {
  const key = (init: KeyboardEventInit) => new KeyboardEvent("keydown", init);
  expect(shortcutFor(key({ key: "z", metaKey: true }), true)).toBe("undo");
  expect(shortcutFor(key({ key: "Z", metaKey: true, shiftKey: true }), true)).toBe("redo");
  expect(shortcutFor(key({ key: "z", ctrlKey: true }), true)).toBeNull();
  expect(shortcutFor(key({ key: "y", metaKey: true }), true)).toBeNull();
  expect(shortcutFor(key({ key: "z", ctrlKey: true }), false)).toBe("undo");
  expect(shortcutFor(key({ key: "y", ctrlKey: true }), false)).toBe("redo");
  expect(shortcutFor(key({ key: "Z", ctrlKey: true, shiftKey: true }), false)).toBe("redo");
  expect(shortcutFor(key({ key: "z", ctrlKey: true, altKey: true }), false)).toBeNull();
  expect(shortcutFor(key({ key: "z" }), false)).toBeNull();
});

it("asks before it reverses many entries at once; cancelling changes nothing", async () => {
  await openList();
  await act(async () => { fireEvent.click(screen.getByLabelText("Select all", { exact: false })); });
  const bar = screen.getByRole("region", { name: `${ROWS} selected` });
  await act(async () => { fireEvent.click([...bar.querySelectorAll("button")].find((button) => button.className.includes("danger"))!); });
  await waitFor(() => expect(value("SELECT COUNT(*) FROM transactions WHERE deleted_at IS NOT NULL")).toBe(ROWS));
  await waitFor(() => expect(control("undo").getAttribute("aria-label")).toBe(`Undo: move to trash (${ROWS} entries)`));
  await act(async () => { fireEvent.click(control("undo")); });
  const dialog = await screen.findByRole("alertdialog");
  expect(dialog.textContent).toContain(`Undo “move to trash (${ROWS} entries)”?`);
  await act(async () => { fireEvent.keyDown(dialog, { key: "Escape" }); });
  expect(screen.queryByRole("alertdialog")).toBeNull();
  expect(value("SELECT COUNT(*) FROM transactions WHERE deleted_at IS NOT NULL")).toBe(ROWS);
  await act(async () => { fireEvent.click(control("undo")); });
  await act(async () => { fireEvent.click([...screen.getByRole("alertdialog").querySelectorAll("button")].find((button) => button.textContent === "Undo")!); });
  await screen.findByText("ROW 07");
  expect(value("SELECT COUNT(*) FROM transactions WHERE deleted_at IS NOT NULL")).toBe(0);
});

it("says so when an edit can no longer be reversed, and offers the one before it", async () => {
  await openList();
  await deleteRow("ROW 07");
  await deleteRow("ROW 08");
  books.get("billieweather.db")!.db.run("UPDATE transactions SET note = 'from elsewhere' WHERE description = 'ROW 08'");
  await waitFor(() => expect(control("undo").getAttribute("aria-label")).toContain("ROW 08"));
  await act(async () => { fireEvent.click(control("undo")); });
  await screen.findByText(/can no longer be reversed exactly/);
  expect(value("SELECT COUNT(*) FROM transactions WHERE deleted_at IS NOT NULL")).toBe(2);
  expect(control("undo").getAttribute("aria-label")).toContain("ROW 07");
});
