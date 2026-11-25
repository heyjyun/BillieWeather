// @vitest-environment jsdom
// Keyboard and screen-reader behaviour (Phase 5.7 audit), and the in-page confirmation before anything is
// deleted for good: in the apps `window.confirm` returns a promise, which an `if` always takes as "yes".
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import initSqlJs from "sql.js";
import { migrate, openInShell, enableAllModulesByDefault } from "./helpers";
import { sqljsDriver } from "../src/services/sqljsDriver";

const files = new Map<string, ReturnType<typeof sqljsDriver>>();
vi.mock("../src/services/platform", async () => {
  const SQL = await initSqlJs();
  return {
    isTauri: () => false,
    openDatabase: async (file = "billieweather.db") => {
      if (!files.has(file)) {
        const db = new SQL.Database();
        migrate(db);
        db.run("INSERT INTO settings (key, value) VALUES ('owner_account_id', 'id:12345678-1234-4123-8123-123456789abc')");
        db.run("INSERT INTO settings (key, value) VALUES ('database_name', 'Manual book')");
        files.set(file, sqljsDriver(db));
      }
      return { driver: files.get(file)!, persistent: true };
    },
    deviceName: async () => "Mac",
    deviceIdentity: async () => null,
    saveFile: async () => true,
    listSnapshots: async () => [],
  };
});

const { default: App } = await import("../src/App");
const { I18nProvider, MESSAGES } = await import("../src/i18n");
const { Login } = await import("../src/pages/Login");
const { AccountProvider } = await import("../src/hooks/useAccount");

beforeEach(() => { enableAllModulesByDefault();
  localStorage.clear(); sessionStorage.clear(); files.clear();
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => String(input).endsWith("/account")
    ? new Response(JSON.stringify({ account: { email: "m@example.com", nickname: null, locale: "en", time_zone: null, usage_region: "US", registered_at: null, badges: [], owner_id: "12345678-1234-4123-8123-123456789abc" } }), { status: 200 })
    : new Response(JSON.stringify({ currency: null, version: "0", statement_count: 0, transaction_count: 0, statements: [], transactions: [], next_after_id: null, rules: [], categories: [] }), { status: 200 }));
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const nav = (name: string) => openInShell(name);
const click = async (element: HTMLElement) => act(async () => { fireEvent.click(element); });
const type = (label: string | RegExp, value: string, root: HTMLElement = document.body) => fireEvent.change(within(root).getByLabelText(label), { target: { value } });


const focused = () => document.activeElement as HTMLElement;
const rows = async (sql: string) => (await files.get("billieweather.db")!.select<{ n: number }>(sql))[0].n;

async function openBook() {
  sessionStorage.setItem("billie.token", "tok");
  render(<App />);
  await screen.findByRole("navigation");
  await click(screen.getByRole("button", { name: "Manual" }));
  await nav("Accounts");
  await screen.findByRole("heading", { name: "Accounts" });
  fireEvent.change(screen.getByLabelText(/^Book currency/), { target: { value: "USD" } });
  await click(screen.getByRole("button", { name: "Add account" }));
  const form = screen.getByRole("form", { name: "New account" });
  type("Name", "ZXQ Checking", form);
  await click(within(form).getByRole("button", { name: "Save" }));
  await screen.findByText("ZXQ Checking");
  await nav("All Transactions");
}

async function addEntry(name: string) {
  await click(await screen.findByRole("button", { name: "New entry" }));
  const form = screen.getByRole("form", { name: "New entry" });
  type("Amount", "12.34", form);
  type(/Merchant/, name, form);
  await click(within(form).getByRole("button", { name: "Save" }));
  await screen.findByText(name);
}

it("announces the interface language from the start, not only after a change", () => {
  document.documentElement.lang = "en";
  localStorage.setItem("billie.locale", "zh-CN");
  render(<I18nProvider><p>x</p></I18nProvider>);
  expect(document.documentElement.lang).toBe("zh-CN");
});

it("returns to the password after a refused sign-in and ties the message to the fields", async () => {
  vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(JSON.stringify({ error: "invalid_credentials" }), { status: 401 }));
  render(<I18nProvider initial="en"><AccountProvider><Login /></AccountProvider></I18nProvider>);
  const x = MESSAGES.en.login;
  type(x.email, "a@example.invalid");
  type(x.password, "wrong");
  await click(screen.getByRole("button", { name: x.submit }));
  const alert = await screen.findByRole("alert");
  const password = screen.getByLabelText(x.password);
  await waitFor(() => expect(focused()).toBe(password));
  expect(password.getAttribute("aria-describedby")).toBe(alert.id);
  expect(password.getAttribute("aria-invalid")).toBe("true");
});

it("moves into a new entry, to its first problem, and back to the button", async () => {
  await openBook();
  const add = await screen.findByRole("button", { name: "New entry" });
  add.focus();
  await click(add);
  const form = screen.getByRole("form", { name: "New entry" });
  expect(focused()).toBe(within(form).getByLabelText("Amount"));
  const [expense, income] = within(form).getAllByRole("radio");
  expense.focus();
  await act(async () => { fireEvent.keyDown(expense, { key: "ArrowRight" }); });
  expect(focused()).toBe(income);
  expect(income.getAttribute("aria-checked")).toBe("true");
  await click(within(form).getByRole("button", { name: "Save" }));
  await waitFor(() => expect(focused()).toBe(within(form).getByLabelText(/^Amount/)));
  await click(within(form).getByRole("button", { name: "Cancel" }));
  await waitFor(() => expect(focused().textContent).toBe("New entry"));
});

it("skips the navigation, and a page change never leaves focus nowhere", async () => {
  await openBook();
  await click(screen.getByRole("button", { name: "Skip to content" }));
  expect(focused()).toBe(document.getElementById("main"));
  await click(screen.getByRole("button", { name: "Add & Sync" }));
  const open = await waitFor(() => within(document.getElementById("capability-import")!).getByRole("button"));
  open.focus();
  await click(open);
  await waitFor(() => expect(focused().tagName).toBe("H1"));
});

it("deletes for good only after the in-page confirmation, whatever window.confirm does", async () => {
  // What tauri-plugin-dialog installs in the apps.
  const asyncConfirm = vi.fn(async () => false);
  vi.stubGlobal("confirm", asyncConfirm);
  await openBook();
  await addEntry("ZXQ One");
  await addEntry("ZXQ Two");
  for (let i = 0; i < 2; i += 1) await click(screen.getAllByRole("button", { name: "Delete" })[0]);
  await waitFor(() => expect(screen.queryByText("ZXQ One")).toBeNull());
  await click(screen.getByRole("button", { name: "Trash" }));
  await screen.findByText("ZXQ One");
  const deleted = "SELECT count(*) AS n FROM transactions WHERE deleted_at IS NOT NULL";
  const total = "SELECT count(*) AS n FROM transactions";
  expect(await rows(deleted)).toBe(2);

  const empty = screen.getByRole("button", { name: "Empty trash" });
  empty.focus();
  await click(empty);
  let dialog = screen.getByRole("alertdialog");
  expect(dialog.textContent).toContain("2");
  expect(focused().textContent).toBe("Cancel");
  expect(await rows(total)).toBe(2);
  await act(async () => { fireEvent.keyDown(dialog, { key: "Escape" }); });
  expect(screen.queryByRole("alertdialog")).toBeNull();
  await waitFor(() => expect(focused()).toBe(empty));
  expect(await rows(total)).toBe(2);

  // One entry: asked first, and only that entry goes.
  await click(screen.getAllByRole("button", { name: "Delete for good" })[0]);
  dialog = screen.getByRole("alertdialog");
  expect(await rows(total)).toBe(2);
  await click(within(dialog).getByRole("button", { name: "Delete for good" }));
  await waitFor(async () => expect(await rows(total)).toBe(1));

  await click(screen.getByRole("button", { name: "Empty trash" }));
  await click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Empty trash" }));
  await waitFor(async () => expect(await rows(total)).toBe(0));
  expect(asyncConfirm).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
});

it("treats a click that lands on <main> (WebKit) as no focus: a closed form returns to the heading", async () => {
  await openBook();
  const add = await screen.findByRole("button", { name: "New entry" });
  document.getElementById("main")!.focus();
  await click(add);
  const form = screen.getByRole("form", { name: "New entry" });
  expect(focused()).toBe(within(form).getByLabelText("Amount"));
  await click(within(form).getByRole("button", { name: "Cancel" }));
  await waitFor(() => expect(focused().tagName).toBe("H1"));
});

it("uses no browser dialogs, which the apps replace with asynchronous ones", () => {
  const walk = (dir: string): string[] => readdirSync(dir).flatMap((name) => { const path = join(dir, name); return statSync(path).isDirectory() ? walk(path) : /\.tsx?$/.test(name) ? [path] : []; });
  const offenders = [join(__dirname, "../src"), join(__dirname, "../../../packages")].flatMap(walk).filter((file) => !/node_modules|\/test\//.test(file))
    .filter((file) => /window\.(confirm|alert|prompt)\(/.test(readFileSync(file, "utf8")));
  expect(offenders).toEqual([]);
});
