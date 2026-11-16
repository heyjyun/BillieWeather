// @vitest-environment jsdom
// Manual bookkeeping through the real screens, without AI and without any import:
// accounts -> new expense -> edit -> trash -> restore -> transfer -> budget -> backup button. Synthetic data only.
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import initSqlJs from "sql.js";
import { migrate } from "./helpers";
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

beforeEach(() => {
  localStorage.clear(); sessionStorage.clear(); files.clear();
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => String(input).endsWith("/account")
    ? new Response(JSON.stringify({ account: { email: "m@example.com", nickname: null, locale: "en", time_zone: null, usage_region: "US", registered_at: null, badges: [], owner_id: "12345678-1234-4123-8123-123456789abc" } }), { status: 200 })
    : new Response(JSON.stringify({ currency: null, version: "0", statement_count: 0, transaction_count: 0, statements: [], transactions: [], next_after_id: null, rules: [], categories: [] }), { status: 200 }));
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const nav = (name: string) => fireEvent.click(within(screen.getByRole("navigation")).getByRole("button", { name }));
const click = async (element: HTMLElement) => act(async () => { fireEvent.click(element); });
const type = (label: string | RegExp, value: string, root: HTMLElement = document.body) => fireEvent.change(within(root).getByLabelText(label), { target: { value } });

it("keeps a complete book by hand: accounts, an expense, edit, trash and restore, a transfer, a budget", async () => {
  sessionStorage.setItem("billie.token", "tok");
  render(<App />);
  await screen.findByRole("navigation");
  // The manual bookkeeping tools live in Manual Mode (see manualMode.test.tsx).
  await click(screen.getByRole("button", { name: "Manual" }));

  // Accounts: choose the book currency, add checking and a card.
  nav("Accounts");
  await screen.findByRole("heading", { name: "Accounts" });
  fireEvent.change(screen.getByLabelText(/^Book currency/), { target: { value: "USD" } });
  for (const [name, type0, opening] of [["ZXQ Checking", "checking", "1000"], ["ZXQ Card", "credit_card", "0"]]) {
    await click(screen.getByRole("button", { name: "Add account" }));
    const form = screen.getByRole("form", { name: "New account" });
    type("Name", name, form);
    fireEvent.change(within(form).getByLabelText("Type"), { target: { value: type0 } });
    type(/^Opening balance/, opening, form);
    await click(within(form).getByRole("button", { name: "Save" }));
    await screen.findByText(name);
  }
  expect(screen.getByText("Net worth").parentElement!.textContent).toContain("$1,000.00");

  // A card purchase.
  nav("Transactions");
  await click(await screen.findByRole("button", { name: "New entry" }));
  let form = screen.getByRole("form", { name: "New entry" });
  type("Amount", "12.34", form);
  fireEvent.change(within(form).getByLabelText("Account"), { target: { value: String((await files.get("billieweather.db")!.select<{ id: number }>("SELECT id FROM accounts WHERE name = 'ZXQ Card'"))[0].id) } });
  fireEvent.change(within(form).getByLabelText("Category"), { target: { value: "Food & dining" } });
  type(/Merchant/, "ZXQ Noodles", form);
  type(/Tags/, "lunch, work", form);
  await click(within(form).getByRole("button", { name: "Save" }));
  await screen.findByText("ZXQ Noodles");
  expect(screen.getByText(/#lunch #work/)).toBeTruthy();

  // Validation: an empty amount is refused with a message.
  await click(screen.getByRole("button", { name: "New entry" }));
  form = screen.getByRole("form", { name: "New entry" });
  await click(within(form).getByRole("button", { name: "Save" }));
  expect(within(form).getByText("Enter an amount.")).toBeTruthy();
  await click(within(form).getByRole("button", { name: "Cancel" }));

  // Edit the amount and note.
  await click(screen.getAllByRole("button", { name: "Edit" })[0]);
  form = await screen.findByRole("form", { name: "Edit entry" });
  type("Amount", "15.00", form);
  type(/Note/, "with Sam", form);
  await click(within(form).getByRole("button", { name: "Save" }));
  await waitFor(() => expect(screen.getByText("-$15.00")).toBeTruthy());

  // Delete -> trash -> restore.
  await click(screen.getByRole("button", { name: "Delete" }));
  await waitFor(() => expect(screen.queryByText("ZXQ Noodles")).toBeNull());
  await click(screen.getByRole("button", { name: "Trash" }));
  await screen.findByText("ZXQ Noodles");
  await click(screen.getByRole("button", { name: "Restore" }));
  await click(screen.getByRole("button", { name: "Back to transactions" }));
  await screen.findByText("ZXQ Noodles");

  // Pay the card from checking: one transfer, two linked legs, never income or spending.
  await click(screen.getByRole("button", { name: "New entry" }));
  form = screen.getByRole("form", { name: "New entry" });
  await click(within(form).getByRole("radio", { name: "Transfer" }));
  type("Amount", "15", form);
  const ids = Object.fromEntries((await files.get("billieweather.db")!.select<{ id: number; name: string }>("SELECT id, name FROM accounts")).map((row) => [row.name, String(row.id)]));
  fireEvent.change(within(form).getByLabelText("From account"), { target: { value: ids["ZXQ Checking"] } });
  fireEvent.change(within(form).getByLabelText("To account"), { target: { value: ids["ZXQ Card"] } });
  await click(within(form).getByRole("button", { name: "Save" }));
  await waitFor(async () => expect((await files.get("billieweather.db")!.select("SELECT * FROM transaction_links WHERE link_type = 'card_payment'")).length).toBe(1));

  nav("Accounts");
  await screen.findByRole("heading", { name: "Accounts" });
  // Checking 1000 - 15; card owes 0 after the repayment; net worth 985.
  expect(screen.getByText("Net worth").parentElement!.textContent).toContain("$985.00");

  // A monthly food budget shows the spending.
  nav("Budgets & schedules");
  const budgets = (await screen.findByRole("heading", { name: "Budgets" })).closest("section")! as HTMLElement;
  fireEvent.change(within(budgets).getByLabelText("For"), { target: { value: "c:Food & dining" } });
  type("Amount", "100", budgets);
  await click(within(budgets).getByRole("button", { name: "Add budget" }));
  await waitFor(() => expect(within(budgets).getByText(/\$15\.00 of \$100\.00/)).toBeTruthy());

  // Every step is in the activity log.
  nav("Data");
  const log = (await screen.findByRole("heading", { name: "Activity log" })).closest("section")! as HTMLElement;
  await waitFor(() => expect(within(log).getAllByText(/Created/).length).toBeGreaterThanOrEqual(3));
  expect(within(log).getByText(/Restored/)).toBeTruthy();
});
