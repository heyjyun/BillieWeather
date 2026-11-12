// @vitest-environment jsdom
// The reusable command bar (packages/nl-action-react) driving BillieWeather's real actions.
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { ActionExecutor, DialogueSession, NaturalLanguageEngine } from "@nlae/core";
import { CommandBar, createLocalController } from "@nlae/react";
import type { Transaction } from "@billie/shared-types";
import { fixtureBytes, newStore } from "../helpers";
import { importFile } from "../../src/services/importFile";
import { billieRegistry, PRODUCT } from "../../src/commands/actions";
import { createAuthorizer, createEntities, createHandlers, type HostDeps } from "../../src/commands/handlers";
import { translateCommandMessage } from "../../src/components/CommandCenter";
import { MESSAGES } from "../../src/i18n";

afterEach(cleanup);

async function mount(locale: "en" | "zh-CN" = "en") {
  const { store } = await newStore();
  await importFile(store, fixtureBytes("basic-amount.csv"), "basic-amount.csv", "USD");
  await store.addCategory("Pets");
  let finance = { transactions: [] as Transaction[], customCategories: [] as string[], currency: "USD" as string | null };
  const refresh = async () => { finance = { transactions: await store.transactions(), customCategories: await store.customCategories(), currency: await store.currency() }; };
  await refresh();
  const deps: HostDeps = { store, data: () => finance, refresh, navigate: () => undefined, setLanguage: () => undefined, setTheme: () => undefined, categoryLabel: (n) => n };
  const registry = billieRegistry();
  const entities = createEntities(deps);
  const tenant = "jyun@example.com#db";
  const controller = createLocalController({
    session: new DialogueSession(new NaturalLanguageEngine(registry, entities)),
    executor: new ActionExecutor({ registry, entities, authorizer: createAuthorizer(), handlers: createHandlers(deps) }),
    entities,
    parseContext: () => ({ product: PRODUCT, tenant, today: "2026-02-15", defaultCurrency: "USD" }),
    executionContext: () => ({ product: PRODUCT, tenant, principal: "jyun@example.com", now: new Date("2026-02-15T12:00:00Z") }),
  });
  const m = MESSAGES[locale];
  const actionName = (id: string) => (m.command.actions as Record<string, string>)[id.replace(".", "_")] ?? id;
  render(<CommandBar controller={controller} labels={m.command.labels} actionName={actionName} format={(msg) => translateCommandMessage(m.command, m.nav as unknown as Record<string, string>, actionName, msg)} />);
  const input = screen.getByRole("combobox");
  const type = async (text: string) => {
    fireEvent.change(input, { target: { value: text } });
    await act(async () => { fireEvent.keyDown(input, { key: "Enter" }); });
  };
  const starbucks = () => finance.transactions.find((t) => t.description.includes("STARBUCKS"))!;
  return { input, type, starbucks, store, data: () => finance };
}

describe("command bar", () => {
  it("answers a read-only question directly, without confirmation", async () => {
    const ui = await mount();
    await ui.type("how much did I spend in January 2026");
    expect(await screen.findByText("Spent $1,716.95 across 3 transaction(s).")).toBeTruthy();
  });

  it("shows an editable preview, changes nothing until confirmed, then offers Undo", async () => {
    const ui = await mount();
    const before = ui.starbucks().category;
    await ui.type("把 Starbucks 改成购物");
    const confirm = await screen.findByRole("button", { name: "Confirm" });
    expect(screen.getByText("1 change(s)")).toBeTruthy();
    expect(ui.starbucks().category).toBe(before);
    // Edit the category in the preview: Shopping → Health.
    const select = screen.getAllByRole("combobox").find((el) => el.tagName === "SELECT" && (el as HTMLSelectElement).value === "Shopping") as HTMLSelectElement;
    await act(async () => { fireEvent.change(select, { target: { value: "Health" } }); });
    await act(async () => { fireEvent.click(await screen.findByRole("button", { name: "Confirm" })); });
    expect(await screen.findByText("1 transaction(s) moved to Health.")).toBeTruthy();
    expect(ui.starbucks().category).toBe("Health");
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Undo" })); });
    await waitFor(() => expect(ui.starbucks().category).toBe(before));
    void confirm;
  });

  it("asks a clarifying question and continues with the chosen option", async () => {
    const ui = await mount();
    await ui.type("delete category");
    expect(await screen.findByText("Which of your categories?")).toBeTruthy();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Pets" })); });
    const confirm = await screen.findByRole("button", { name: "Confirm" });
    // Destructive: disabled until the name is typed.
    expect((confirm as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText(/Type .*Pets.* to confirm/), { target: { value: "pets" } });
    expect((confirm as HTMLButtonElement).disabled).toBe(false);
    await act(async () => { fireEvent.click(confirm); });
    expect(await screen.findByText(/Deleted “Pets”/)).toBeTruthy();
    expect(ui.data().customCategories).not.toContain("Pets");
  });

  it("says when a command is not supported and changes nothing", async () => {
    const ui = await mount();
    const before = JSON.stringify(ui.data().transactions);
    await ui.type("delete everything");
    expect(await screen.findByText("I can't do that yet.")).toBeTruthy();
    expect(JSON.stringify(ui.data().transactions)).toBe(before);
  });

  it("is keyboard driven: suggestions open, arrow keys choose, Enter fills the input", async () => {
    const ui = await mount();
    fireEvent.focus(ui.input);
    fireEvent.change(ui.input, { target: { value: "how much" } });
    const list = await screen.findByRole("listbox");
    expect(within(list).getAllByRole("option").length).toBeGreaterThan(0);
    fireEvent.keyDown(ui.input, { key: "ArrowDown" });
    expect(ui.input.getAttribute("aria-activedescendant")).toBeTruthy();
    fireEvent.keyDown(ui.input, { key: "Enter" });
    expect((ui.input as HTMLInputElement).value.toLowerCase()).toContain("how much");
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("uses the interface language for its own text", async () => {
    const ui = await mount("zh-CN");
    await ui.type("上个月餐饮花了多少钱");
    expect(await screen.findByText(/^共支出/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "执行" })).toBeTruthy();
  });
});
